// W19a：上下文引用解析冒烟。
// 验证：消息含 [[某笔记]] → 模型回答体现已读该笔记内容，且 md 中 user callout 无全文、只有链接。

import { SessionEngine } from '../src/engine.js';

function makeVaultIO() {
  const files = new Map();
  const dirs = new Set();
  return {
    read: async (path) => files.get(path) || '',
    write: async (path, text) => files.set(path, text),
    append: async (path, text) => files.set(path, (files.get(path) || '') + text),
    exists: async (path) => files.has(path),
    rename: async (oldPath, newPath) => {
      const text = files.get(oldPath);
      files.delete(oldPath);
      files.set(newPath, text);
    },
    mkdir: async (path) => { dirs.add(path); },
    _files: files,
    _dirs: dirs,
  };
}

async function main() {
  const vaultIO = makeVaultIO();
  vaultIO._files.set('Seattle.md', 'Seattle 是华盛顿州最大城市，太空针塔高 184 米。');

  let receivedBody = null;
  let missingEvent = null;

  // 用本地 gateway 或 mock；这里直接用 mock server 简便
  const server = (await import('node:http')).createServer((req, res) => {
    let body = '';
    req.on('data', (c) => body += c);
    req.on('end', () => {
      receivedBody = JSON.parse(body);
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.write('data: {"choices":[{"delta":{"content":"Seattle"},"finish_reason":null}]},\n\n');
      res.write('data: {"choices":[{"delta":{"content":" 太空针塔高 184 米。"},"finish_reason":"stop"}]},\n\n');
      res.end('data: [DONE]\n\n');
    });
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  const url = `http://127.0.0.1:${port}`;

  const engine = new SessionEngine({
    gatewayUrl: url,
    model: 'deepseek-chat',
    thinking: false,
    search: false,
    vaultIO,
    tokenBudgetChars: 100000,
    onEvent: (e) => {
      if (e.type === 'reference-missing') missingEvent = e;
    },
  });

  try {
    await engine.send('[[Seattle]] 的地标有多高？顺便问 [[不存在的笔记]]。');
    const md = vaultIO._files.get(engine.sessionPath);

    const systemMsg = receivedBody.messages.find((m) => m.role === 'system');
    const userMsg = receivedBody.messages.find((m) => m.role === 'user');

    const report = {
      url,
      sessionPath: engine.sessionPath,
      hasSystemContext: !!systemMsg && systemMsg.content.includes('太空针塔'),
      userMessageContainsWikilink: !!userMsg && userMsg.content.includes('[[Seattle]]'),
      mdUserCalloutHasLinkOnly: md.includes('[[Seattle]]') && !md.includes('太空针塔'),
      missingEventNames: missingEvent?.names || [],
      ok: false,
      testedAt: new Date().toISOString(),
    };
    report.ok = report.hasSystemContext && report.userMessageContainsWikilink && report.mdUserCalloutHasLinkOnly;

    (await import('node:fs')).writeFileSync(
      new URL('../docs/w19a-smoke-report.json', import.meta.url),
      JSON.stringify(report, null, 2),
      'utf8'
    );
    console.log(report.ok ? '✅ W19a smoke 通过' : '❌ W19a smoke 失败');
    console.log(JSON.stringify(report, null, 2));
    process.exit(report.ok ? 0 : 1);
  } finally {
    server.close();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
