#!/usr/bin/env node
// T4 桌面插件半自动验收脚本（CDP 驱动 Obsidian Electron）
// 用法：先启动 Obsidian --remote-debugging-port=9224 并打开 test-vault-t4

const fs = require('fs');
const path = require('path');

const CDP_LIST = 'http://127.0.0.1:9224/json/list';
const SHOT_DIR = path.join(__dirname, '..', 'docs', 'T4-screenshots');
const VAULT_DIR = path.join(__dirname, '..', 'test-vault-t4');

fs.mkdirSync(SHOT_DIR, { recursive: true });

async function getWsUrl() {
  const res = await fetch(CDP_LIST);
  const list = await res.json();
  const page = list.find((x) => x.type === 'page');
  if (!page) throw new Error('no CDP page found');
  return page.webSocketDebuggerUrl;
}

async function connect() {
  const wsUrl = await getWsUrl();
  const ws = new WebSocket(wsUrl);
  await new Promise((resolve, reject) => {
    ws.onopen = resolve;
    ws.onerror = reject;
  });

  let id = 0;
  const pending = new Map();
  ws.onmessage = (e) => {
    const msg = JSON.parse(e.data);
    if (msg.id && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id);
      pending.delete(msg.id);
      if (msg.error) reject(new Error(JSON.stringify(msg.error)));
      else resolve(msg.result);
    }
  };

  const send = (method, params = {}) =>
    new Promise((resolve, reject) => {
      const i = ++id;
      pending.set(i, { resolve, reject });
      ws.send(JSON.stringify({ id: i, method, params }));
    });

  const evaluate = async (expression, awaitPromise = true) => {
    const r = await send('Runtime.evaluate', {
      expression,
      returnByValue: true,
      awaitPromise,
    });
    if (r.exceptionDetails) {
      throw new Error(
        r.exceptionDetails.exception?.description || r.exceptionDetails.text
      );
    }
    return r.result.value;
  };

  const screenshot = async (name) => {
    const r = await send('Page.captureScreenshot', { format: 'png' });
    const file = path.join(SHOT_DIR, `${name}.png`);
    fs.writeFileSync(file, Buffer.from(r.data, 'base64'));
    return file;
  };

  return { send, evaluate, screenshot, close: () => ws.close() };
}

async function waitFor(predicate, interval = 500, timeout = 120000) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    if (await predicate()) return;
    await new Promise((r) => setTimeout(r, interval));
  }
  throw new Error('waitFor timeout');
}

async function main() {
  const client = await connect();
  const log = (...args) => console.log(...args);
  const results = [];

  try {
    // 1. 启用插件视图并设置 expert + 搜索
    log('==> Activating AI Vault Chat view...');
    await client.evaluate(`
      (async () => {
        const plugin = app.plugins.plugins['ai-vault-chat'];
        if (!plugin) throw new Error('plugin not loaded');
        plugin.settings.model = 'expert';
        plugin.settings.search = true;
        plugin.settings.thinking = true;
        await plugin.saveSettings();
        await plugin.activateView();
        return 'activated';
      })()
    `);
    await new Promise((r) => setTimeout(r, 500));
    const shot1 = await client.screenshot('01-view-opened');
    log('screenshot:', shot1);

    // 2. 新会话并发送第一轮
    log('==> New session, round 1 (expert + search)...');
    await client.evaluate(`
      (async () => {
        const leaf = app.workspace.getLeavesOfType('ai-vault-chat-view')[0];
        const view = leaf.view;
        view.newSession();
        view.inputEl.value = '你好，请用一句话介绍自己';
        view.sendBtnEl.click();
        return 'sent';
      })()
    `);
    await waitFor(
      () =>
        client.evaluate(
          `app.workspace.getLeavesOfType('ai-vault-chat-view')[0].view.isStreaming === false`
        ),
      500,
      120000
    );
    const sessionPath1 = await client.evaluate(
      `app.vault.getFiles().filter(f => f.path.startsWith('AI 会话/') && f.extension === 'md').sort((a, b) => b.stat.mtime - a.stat.mtime)[0]?.path`
    );
    if (sessionPath1) {
      await client.evaluate(`app.workspace.getLeavesOfType('ai-vault-chat-view')[0].view.loadSession(${JSON.stringify(sessionPath1)})`);
      await new Promise((r) => setTimeout(r, 200));
    }
    const shot2 = await client.screenshot('02-round1-done');
    log('screenshot:', shot2);
    results.push({ step: 'round1', status: 'done', sessionPath: sessionPath1 });

    // 3. 发送第二轮
    log('==> Round 2...');
    await client.evaluate(`
      (async () => {
        const view = app.workspace.getLeavesOfType('ai-vault-chat-view')[0].view;
        view.inputEl.value = '请给出一个 Markdown 表格示例';
        view.sendBtnEl.click();
        return 'sent';
      })()
    `);
    await waitFor(
      () =>
        client.evaluate(
          `app.workspace.getLeavesOfType('ai-vault-chat-view')[0].view.isStreaming === false`
        ),
      500,
      120000
    );
    if (sessionPath1) {
      await client.evaluate(`app.workspace.getLeavesOfType('ai-vault-chat-view')[0].view.loadSession(${JSON.stringify(sessionPath1)})`);
      await new Promise((r) => setTimeout(r, 200));
    }
    const shot3 = await client.screenshot('03-round2-done');
    log('screenshot:', shot3);
    results.push({ step: 'round2', status: 'done' });

    // 4. 读取会话文件并检查渲染产物
    log('==> Reading session markdown...');
    const sessionPath = await client.evaluate(
      `app.vault.getFiles().filter(f => f.path.startsWith('AI 会话/') && f.extension === 'md').sort((a, b) => b.stat.mtime - a.stat.mtime)[0]?.path`
    );
    if (!sessionPath) throw new Error('no session file found');
    const sessionInfo = { path: sessionPath, basename: path.basename(sessionPath, '.md') };
    log('session:', sessionInfo);
    const mdContent = await client.evaluate(
      `app.vault.adapter.read(${JSON.stringify(sessionInfo.path)})`
    );
    const mdFile = path.join(SHOT_DIR, '04-session.md');
    fs.writeFileSync(mdFile, mdContent);
    log('markdown saved:', mdFile);

    // 4b. 在主区域打开该 md 并截图，验证 Obsidian 原生渲染
    await client.evaluate(`
      (async () => {
        const file = app.vault.getAbstractFileByPath(${JSON.stringify(sessionInfo.path)});
        if (file) await app.workspace.getLeaf().openFile(file);
        return 'opened';
      })()
    `);
    await new Promise((r) => setTimeout(r, 300));
    const shot3b = await client.screenshot('03b-md-rendered');
    log('screenshot:', shot3b);
    results.push({
      step: 'markdown',
      status: 'saved',
      hasUserCallout: mdContent.includes('> [!user]'),
      hasAiCallout: mdContent.includes('> [!ai]'),
      hasThink: mdContent.includes('> [!think]') || mdContent.includes('> [!thinking]'),
      hasSearch: mdContent.includes('> [!search]'),
      hasTable: mdContent.includes('|'),
    });

    // 5. 关闭视图后重开并继续同一会话
    log('==> Close & reopen plugin, resume session...');
    await client.evaluate(`app.workspace.detachLeavesOfType('ai-vault-chat-view')`);
    await new Promise((r) => setTimeout(r, 300));
    await client.evaluate(`app.plugins.plugins['ai-vault-chat'].activateView()`);
    await new Promise((r) => setTimeout(r, 300));
    await client.evaluate(`app.workspace.getLeavesOfType('ai-vault-chat-view')[0].view.loadSession(${JSON.stringify(sessionInfo.path)})`);
    await client.evaluate(`
      var view2 = app.workspace.getLeavesOfType('ai-vault-chat-view')[0].view;
      view2.inputEl.value = '继续刚才的话题';
      view2.sendBtnEl.click();
      'resumed';
    `);
    await waitFor(
      () =>
        client.evaluate(
          `app.workspace.getLeavesOfType('ai-vault-chat-view')[0].view.isStreaming === false`
        ),
      500,
      120000
    );
    const shot4 = await client.screenshot('04-resume-done');
    log('screenshot:', shot4);
    results.push({ step: 'resume', status: 'done' });

    // 6. 当前笔记上下文开关：打开一个普通笔记并切换上下文
    log('==> Context toggle test...');
    const contextNote = 'Context-Note.md';
    await client.evaluate(`
      (async () => {
        let file = app.vault.getAbstractFileByPath(${JSON.stringify(contextNote)});
        if (!file) {
          file = await app.vault.create(${JSON.stringify(contextNote)}, '# Context Note\\nThis is a test note for context injection.\\n');
        }
        await app.workspace.getLeaf().openFile(file);
        var view = app.workspace.getLeavesOfType('ai-vault-chat-view')[0].view;
        view.contextToggleEl.checked = true;
        view.inputEl.value = '总结一下当前笔记';
        view.sendBtnEl.click();
        return 'context-on';
      })()
    `);
    await waitFor(
      () =>
        client.evaluate(
          `app.workspace.getLeavesOfType('ai-vault-chat-view')[0].view.isStreaming === false`
        ),
      500,
      120000
    );
    const shot5 = await client.screenshot('05-context-on');
    log('screenshot:', shot5);
    results.push({ step: 'context-on', status: 'done' });

    // 关闭上下文再发一条
    await client.evaluate(`
      (async () => {
        var view = app.workspace.getLeavesOfType('ai-vault-chat-view')[0].view;
        view.contextToggleEl.checked = false;
        view.inputEl.value = '再随便说点什么';
        view.sendBtnEl.click();
        return 'context-off';
      })()
    `);
    await waitFor(
      () =>
        client.evaluate(
          `app.workspace.getLeavesOfType('ai-vault-chat-view')[0].view.isStreaming === false`
        ),
      500,
      120000
    );
    const shot6 = await client.screenshot('06-context-off');
    log('screenshot:', shot6);
    results.push({ step: 'context-off', status: 'done' });

    // 7. 中断 resume 测试：停止外部 gateway，发送消息触发失败，再重启 gateway 并 resume
    log('==> Interruption resume test...');
    // 这里仅能在本脚本外部控制 gateway；脚本只负责触发 resume UI 并截图。
    // 先尝试调用 resumeCurrent（若已有中断标记则可见）
    await client.evaluate(`
      (async () => {
        var view = app.workspace.getLeavesOfType('ai-vault-chat-view')[0].view;
        await view.resumeCurrent();
        return 'resume-clicked';
      })()
    `);
    await new Promise((r) => setTimeout(r, 500));
    const shot7 = await client.screenshot('07-resume-clicked');
    log('screenshot:', shot7);
    results.push({ step: 'resume-clicked', status: 'done' });

    log('\nRESULTS:', JSON.stringify(results, null, 2));
  } finally {
    client.close();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
