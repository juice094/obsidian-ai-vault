import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import mock from '../scripts/openclaw-mock-server.cjs';
import { OpenClawProvider } from '../src/openclaw-provider.js';
import { SessionEngine } from '../src/engine.js';

const { createMockServer, DEFAULT_TOKEN } = mock;

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

describe('OpenClawProvider', () => {
  it('completes challenge → connect → hello-ok → chat.send → ChatChunk* → Done', async () => {
    let connectParams = null;
    let chatParams = null;
    const { server, url } = await createMockServer({
      token: 'test-token',
      onConnect: (params) => { connectParams = params; },
      onChat: (params) => { chatParams = params; },
    });

    try {
      const provider = new OpenClawProvider({ url, token: 'test-token' });
      const events = [];
      for await (const ev of provider.streamChat({
        messages: [{ role: 'user', content: 'hello' }],
        model: 'deepseek-chat',
        thinking: false,
        search: false,
        signal: new AbortController().signal,
      })) {
        events.push(ev);
      }

      assert.deepEqual(events.map(e => e.type), ['content', 'content', 'content', 'finish']);
      assert.equal(events.map(e => e.delta).join(''), 'Hello from spike.');

      assert.ok(connectParams, 'connect params received');
      assert.equal(connectParams.client.id, 'cli');
      assert.equal(connectParams.auth.token, 'test-token');
      assert.ok(connectParams.scopes.includes('operator.write'));

      assert.ok(chatParams, 'chat.send params received');
      assert.equal(chatParams.sessionKey, 'agent:main:main');
      assert.equal(chatParams.message[0].type, 'text');
      assert.equal(chatParams.message[0].text, 'hello');
    } finally {
      server.close();
    }
  });

  it('rejects on bad admin token', async () => {
    const { server, url } = await createMockServer({ token: 'test-token' });

    try {
      const provider = new OpenClawProvider({ url, token: 'wrong-token' });
      await assert.rejects(async () => {
        for await (const _ of provider.streamChat({
          messages: [{ role: 'user', content: 'hello' }],
          model: 'deepseek-chat',
          thinking: false,
          search: false,
          signal: new AbortController().signal,
        })) {
          // noop
        }
      }, /connect failed/);
    } finally {
      server.close();
    }
  });

  it('closes websocket and throws AbortError when signal aborts', async () => {
    const { server, url } = await createMockServer({ token: 'test-token' });

    try {
      const provider = new OpenClawProvider({ url, token: 'test-token' });
      const controller = new AbortController();
      const events = [];

      const consume = (async () => {
        for await (const ev of provider.streamChat({
          messages: [{ role: 'user', content: 'abort me' }],
          model: 'deepseek-chat',
          thinking: false,
          search: false,
          signal: controller.signal,
        })) {
          events.push(ev);
          if (events.length === 1) {
            controller.abort();
          }
        }
      })();

      await assert.rejects(() => consume, /AbortError/);
      assert.ok(events.length >= 1, 'received at least one chunk before abort');
      assert.equal(events[0].type, 'content');
    } finally {
      server.close();
    }
  });

  it('integrates with SessionEngine and writes interruption warning on abort', async () => {
    const vaultIO = makeVaultIO();
    const events = [];
    const { server, url } = await createMockServer({ token: 'test-token' });

    try {
      const engine = new SessionEngine({
        provider: 'openclaw',
        openclawUrl: url,
        openclawToken: 'test-token',
        model: 'deepseek-chat',
        thinking: false,
        search: false,
        vaultIO,
        onEvent: (e) => events.push(e),
      });

      const sendPromise = engine.send('abort me');
      // 等待 user-saved 后再 abort
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
