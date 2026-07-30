import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { SessionEngine } from '../src/engine.js';

function makeVaultIO() {
  const files = new Map();
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
    _files: files,
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
      assert.ok(md.includes('> [!user]'));
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
});
