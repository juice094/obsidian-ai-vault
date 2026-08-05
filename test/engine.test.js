import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
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
    list: async () => [...files.keys()].filter((p) => p.endsWith('.md')),
    _files: files,
    _dirs: dirs,
  };
}

function mockSseStream() {
  const lines = [
    'data: {"id":"cmpl-1","object":"chat.completion.chunk","created":1,"model":"deepseek-chat","choices":[{"index":0,"delta":{"role":"assistant"}}]}\n\n',
    'data: {"id":"cmpl-1","object":"chat.completion.chunk","created":1,"model":"deepseek-chat","choices":[{"index":0,"delta":{"reasoning_content":"思考中"}}]}\n\n',
    'data: {"id":"cmpl-1","object":"chat.completion.chunk","created":1,"model":"deepseek-chat","choices":[{"index":0,"delta":{"content":"答案"}}]}\n\n',
    'data: {"id":"cmpl-1","object":"chat.completion.chunk","created":1,"model":"deepseek-chat","choices":[{"index":0,"delta":{"search_results":{"queries":["x"],"results":[{"url":"https://x","title":"X","snippet":"x","cite_index":1,"site_name":"X"}]}}}]}\n\n',
    'data: {"id":"cmpl-1","object":"chat.completion.chunk","created":1,"model":"deepseek-chat","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\n',
    'data: [DONE]\n\n',
  ];
  return lines.join('');
}

function startMockServer(handler) {
  return new Promise((resolve) => {
    const server = http.createServer(handler);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({ server, url: `http://127.0.0.1:${port}` });
    });
  });
}

describe('SessionEngine', () => {
  it('creates a new session and streams a turn', async () => {
    const vaultIO = makeVaultIO();
    const events = [];
    let receivedBody = null;

    const { server, url } = await startMockServer((req, res) => {
      let body = '';
      req.on('data', c => body += c);
      req.on('end', () => {
        receivedBody = JSON.parse(body);
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        res.end(mockSseStream());
      });
    });

    try {
      const engine = new SessionEngine({
        gatewayUrl: url,
        model: 'deepseek-chat',
        thinking: true,
        search: true,
        vaultIO,
        onEvent: (e) => events.push(e),
      });

      await engine.send('hello world');

      assert.ok(receivedBody);
      assert.equal(receivedBody.stream, true);
      assert.equal(receivedBody.messages.length, 1);
      assert.equal(receivedBody.messages[0].role, 'user');

      assert.ok(engine.sessionPath.startsWith('AI 会话/'));
      assert.ok(engine.sessionPath.endsWith('.md'));

      const md = vaultIO._files.get(engine.sessionPath);
      assert.ok(md.includes('> [!user] 你'));
      assert.ok(md.includes('hello world'));
      assert.ok(md.includes('> [!think]- 已思考'));
      assert.ok(md.includes('思考中'));
      assert.ok(md.includes('> [!search]- 已阅读'));
      assert.ok(md.includes('[X](https://x)'));
      assert.ok(md.includes('<!-- ai:end -->'));
      assert.ok(md.includes('答案'));

      assert.ok(events.some(e => e.type === 'user-saved'));
      assert.ok(events.some(e => e.type === 'content-delta'));
      assert.ok(events.some(e => e.type === 'think-delta'));
      assert.ok(events.some(e => e.type === 'search-done'));
      assert.ok(events.some(e => e.type === 'turn-done'));
    } finally {
      server.close();
    }
  });

  it('defaults openclaw session key to obsidian-{sessionId}', async () => {
    let sessionKeyHeader = null;
    let agentIdHeader = null;
    const vaultIO = makeVaultIO();
    const { server, url } = await startMockServer((req, res) => {
      sessionKeyHeader = req.headers['x-openclaw-session-key'];
      agentIdHeader = req.headers['x-openclaw-agent-id'];
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.end(mockSseStream());
    });

    try {
      const engine = new SessionEngine({
        gatewayUrl: 'http://ignored',
        model: 'openclaw/default',
        thinking: false,
        search: false,
        vaultIO,
        route: 'openclaw',
        openclawUrl: url,
        openclawToken: 'test-token',
        agentId: 'gray',
      });

      assert.ok(engine.sessionKey.startsWith('obsidian-'));
      await engine.send('hello');
      assert.equal(sessionKeyHeader, engine.sessionKey);
      assert.equal(agentIdHeader, 'gray');
      assert.ok(engine.sessionPath.startsWith('AI 会话/'));
      const md = vaultIO._files.get(engine.sessionPath);
      assert.ok(md.includes('route=openclaw'));
    } finally {
      server.close();
    }
  });

  it('uses agent:main:main for openclaw main session entry and records meta', async () => {
    let sessionKeyHeader = null;
    let agentIdHeader = null;
    const vaultIO = makeVaultIO();
    const { server, url } = await startMockServer((req, res) => {
      sessionKeyHeader = req.headers['x-openclaw-session-key'];
      agentIdHeader = req.headers['x-openclaw-agent-id'];
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.end(mockSseStream());
    });

    try {
      const engine = new SessionEngine({
        gatewayUrl: 'http://ignored',
        model: 'openclaw/default',
        thinking: false,
        search: false,
        vaultIO,
        route: 'openclaw',
        openclawUrl: url,
        openclawToken: 'test-token',
        peerAgent: 'main',
        sessionEntry: 'main',
      });

      assert.equal(engine.sessionKey, 'agent:main:main');
      await engine.send('hello');
      assert.equal(sessionKeyHeader, 'agent:main:main');
      assert.equal(agentIdHeader, 'gray');
      const md = vaultIO._files.get(engine.sessionPath);
      assert.ok(md.includes('route=openclaw'));
      assert.ok(md.includes('agent=main'));
      assert.ok(md.includes('entry=main'));
    } finally {
      server.close();
    }
  });

  it('records device peerAgent in turn meta', async () => {
    let agentIdHeader = null;
    const vaultIO = makeVaultIO();
    const { server, url } = await startMockServer((req, res) => {
      agentIdHeader = req.headers['x-openclaw-agent-id'];
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.end(mockSseStream());
    });

    try {
      const engine = new SessionEngine({
        gatewayUrl: 'http://ignored',
        model: 'openclaw/default',
        thinking: false,
        search: false,
        vaultIO,
        route: 'openclaw',
        openclawUrl: url,
        openclawToken: 'test-token',
        peerAgent: 'device',
      });

      await engine.send('hello');
      assert.equal(agentIdHeader, 'device');
      const md = vaultIO._files.get(engine.sessionPath);
      assert.ok(md.includes('agent=device'));
      assert.ok(md.includes('entry=note'));
    } finally {
      server.close();
    }
  });

  it('sanitizes illegal filename characters from the session title', async () => {
    const vaultIO = makeVaultIO();
    const { server, url } = await startMockServer((req, res) => {
      req.on('data', () => {});
      req.on('end', () => {
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        res.end(mockSseStream());
      });
    });

    try {
      const engine = new SessionEngine({
        gatewayUrl: url,
        model: 'deepseek-chat',
        thinking: false,
        search: false,
        vaultIO,
      });
      const userText = '执行出错 程序异常退出, 请检查代码"是';
      await engine.send(userText);

      assert.ok(engine.sessionPath.startsWith('AI 会话/'));
      assert.ok(engine.sessionPath.endsWith('.md'));
      assert.ok(!engine.sessionPath.includes('"'));
      assert.ok(!/[<>:"|?*\\\x00-\x1f]/.test(engine.sessionPath));
      assert.ok(vaultIO._files.has(engine.sessionPath));
    } finally {
      server.close();
    }
  });

  it('continues an existing session', async () => {
    const vaultIO = makeVaultIO();
    const { server, url } = await startMockServer((req, res) => {
      let body = '';
      req.on('data', c => body += c);
      req.on('end', () => {
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        res.end(mockSseStream());
      });
    });

    try {
      const engine = new SessionEngine({
        gatewayUrl: url,
        model: 'deepseek-chat',
        thinking: false,
        search: false,
        vaultIO,
      });
      await engine.send('first');
      await engine.send('second');

      const md = vaultIO._files.get(engine.sessionPath);
      const turns = md.split('---').filter(s => s.includes('turn:'));
      assert.equal(turns.length, 2);
    } finally {
      server.close();
    }
  });

  it('batches streaming writes to reduce disk amplification', async () => {
    const vaultIO = makeVaultIO();
    let writeCount = 0;
    const originalWrite = vaultIO.write;
    vaultIO.write = async (path, text) => {
      writeCount++;
      return originalWrite(path, text);
    };

    const lines = [
      'data: {"id":"cmpl-1","object":"chat.completion.chunk","created":1,"model":"deepseek-chat","choices":[{"index":0,"delta":{"role":"assistant"}}]}\n\n',
    ];
    for (let i = 0; i < 100; i++) {
      lines.push('data: {"id":"cmpl-1","object":"chat.completion.chunk","created":1,"model":"deepseek-chat","choices":[{"index":0,"delta":{"content":"答案"}}]}\n\n');
    }
    lines.push('data: {"id":"cmpl-1","object":"chat.completion.chunk","created":1,"model":"deepseek-chat","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\n');
    lines.push('data: [DONE]\n\n');

    const { server, url } = await startMockServer((req, res) => {
      let body = '';
      req.on('data', c => body += c);
      req.on('end', () => {
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        res.end(lines.join(''));
      });
    });

    try {
      const engine = new SessionEngine({
        gatewayUrl: url,
        model: 'deepseek-chat',
        thinking: false,
        search: false,
        vaultIO,
      });
      await engine.send('流式写入批处理测试');
      assert.ok(writeCount <= 10, `expected <= 10 writes, got ${writeCount}`);
      const md = vaultIO._files.get(engine.sessionPath);
      assert.ok(md.includes('答案'.repeat(100)));
      assert.ok(md.includes('<!-- ai:end -->'));
    } finally {
      server.close();
    }
  });

  it('resume marks in-progress turn as interrupted', async () => {
    const vaultIO = makeVaultIO();
    vaultIO.write('AI 会话/2026-07-29 test.md', `---
chat_format: 1
session_id: s1
model: deepseek-chat
thinking: false
search: false
created: 2026-07-29T00:00:00.000Z
---

<!-- turn:1 user_msg=1 ai_msg=2 -->
> [!user]
> hello

<!-- ai:begin id=2 -->
writing...
`);

    const engine = new SessionEngine({
      gatewayUrl: 'http://127.0.0.1:1',
      model: 'deepseek-chat',
      thinking: false,
      search: false,
      vaultIO,
    });
    engine.sessionPath = 'AI 会话/2026-07-29 test.md';

    await engine.resume();
    const md = vaultIO._files.get(engine.sessionPath);
    assert.ok(md.includes('> [!warning]- 本轮中断'));
    assert.ok(md.includes('<!-- ai:end -->'));
  });

  it('creates AI 会话 directory before writing the first session file', async () => {
    const files = new Map();
    const dirs = new Set();
    const vaultIO = {
      read: async (path) => files.get(path) || '',
      write: async (path, text) => {
        if (!dirs.has('AI 会话')) {
          const err = new Error(`ENOENT: no such file or directory, open '${path}'`);
          err.code = 'ENOENT';
          throw err;
        }
        files.set(path, text);
      },
      append: async (path, text) => files.set(path, (files.get(path) || '') + text),
      exists: async (path) => files.has(path),
      rename: async (oldPath, newPath) => {
        const text = files.get(oldPath);
        files.delete(oldPath);
        files.set(newPath, text);
      },
      mkdir: async (path) => { dirs.add(path); },
      list: async () => [...files.keys()].filter((p) => p.endsWith('.md')),
    };

    const { server, url } = await startMockServer((req, res) => {
      let body = '';
      req.on('data', c => body += c);
      req.on('end', () => {
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        res.end(mockSseStream());
      });
    });

    try {
      const engine = new SessionEngine({
        gatewayUrl: url,
        model: 'deepseek-chat',
        thinking: false,
        search: false,
        vaultIO,
      });

      await assert.doesNotReject(async () => engine.send('hello world'));
      assert.ok(dirs.has('AI 会话'));
      assert.ok(engine.sessionPath.startsWith('AI 会话/'));
      assert.ok(files.has(engine.sessionPath));
    } finally {
      server.close();
    }
  });

  it('injects referenced note content as system context and emits reference-missing for missing links', async () => {
    const files = new Map();
    files.set('旅行预算.md', '预算 5000 元，机票 3000。');
    const dirs = new Set();
    const vaultIO = {
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
      list: async () => [...files.keys()].filter((p) => p.endsWith('.md')),
      _files: files,
      _dirs: dirs,
    };

    let receivedBody = null;
    let missingEvent = null;
    const { server, url } = await startMockServer((req, res) => {
      let body = '';
      req.on('data', c => body += c);
      req.on('end', () => {
        receivedBody = JSON.parse(body);
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        res.end(mockSseStream());
      });
    });

    try {
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
      await engine.send('根据 [[旅行预算]] 和 [[不存在的笔记]] 给建议');

      assert.ok(receivedBody);
      const systemMessages = receivedBody.messages.filter((m) => m.role === 'system');
      assert.equal(systemMessages.length, 1);
      assert.ok(systemMessages[0].content.includes('旅行预算'));
      assert.ok(systemMessages[0].content.includes('预算 5000 元'));
      assert.ok(!systemMessages[0].content.includes('不存在的笔记'));

      assert.ok(missingEvent);
      assert.deepEqual(missingEvent.names, ['不存在的笔记']);

      const md = vaultIO._files.get(engine.sessionPath);
      // md 中 user callout 只保留原始链接，不注入全文
      assert.ok(md.includes('[[旅行预算]]'));
      assert.ok(!md.includes('预算 5000 元'));
    } finally {
      server.close();
    }
  });

  it('emits user-saved event with the new session path so the view can switch to it', async () => {
    const vaultIO = makeVaultIO();
    const events = [];

    const { server, url } = await startMockServer((req, res) => {
      let body = '';
      req.on('data', c => body += c);
      req.on('end', () => {
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        res.end(mockSseStream());
      });
    });

    try {
      const engine = new SessionEngine({
        gatewayUrl: url,
        model: 'deepseek-chat',
        thinking: false,
        search: false,
        vaultIO,
        onEvent: (e) => events.push(e),
      });

      await engine.send('first message');

      const userSaved = events.find(e => e.type === 'user-saved');
      assert.ok(userSaved);
      assert.equal(userSaved.path, engine.sessionPath);
      assert.ok(engine.sessionPath.startsWith('AI 会话/'));
    } finally {
      server.close();
    }
  });

  it('aborts an in-progress turn and marks it as interrupted', async () => {
    const vaultIO = makeVaultIO();
    const events = [];

    const { server, url } = await startMockServer((req, res) => {
      let body = '';
      req.on('data', c => body += c);
      req.on('end', () => {
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        res.write('data: {"id":"cmpl-1","object":"chat.completion.chunk","created":1,"model":"deepseek-chat","choices":[{"index":0,"delta":{"role":"assistant"}}]}\n\n');
        res.write('data: {"id":"cmpl-1","object":"chat.completion.chunk","created":1,"model":"deepseek-chat","choices":[{"index":0,"delta":{"content":" partial"}}]}\n\n');
        // 保持连接不结束，给 abort 留出时间
        setTimeout(() => res.end(), 5000);
      });
    });

    try {
      const engine = new SessionEngine({
        gatewayUrl: url,
        model: 'deepseek-chat',
        thinking: false,
        search: false,
        vaultIO,
        onEvent: (e) => events.push(e),
      });

      const sendPromise = engine.send('abort me');
      // 等待 user-saved 后再 abort，确保 turn 已写入
      while (!events.some(e => e.type === 'user-saved')) {
        await new Promise(r => setTimeout(r, 10));
      }
      // 稍等流式开始再 abort
      await new Promise(r => setTimeout(r, 80));
      engine.abort();
      await sendPromise;

      const md = vaultIO._files.get(engine.sessionPath);
      assert.ok(md.includes('> [!warning]- 本轮中断'));
      assert.ok(md.includes('<!-- ai:end -->'));
      assert.ok(events.some(e => e.type === 'turn-done'));
    } finally {
      server.close();
    }
  });
});
