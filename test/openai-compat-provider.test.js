import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { OpenAICompatProvider } from '../src/openai-compat-provider.js';

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

describe('OpenAICompatProvider', () => {
  it('yields reasoning, content, search_results and finish events in order', async () => {
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
      const provider = new OpenAICompatProvider({ gatewayUrl: url });
      const events = [];
      for await (const ev of provider.streamChat({
        messages: [{ role: 'user', content: 'hello' }],
        model: 'deepseek-chat',
        thinking: true,
        search: true,
        signal: new AbortController().signal,
      })) {
        events.push(ev);
      }

      assert.ok(receivedBody);
      assert.equal(receivedBody.stream, true);
      assert.equal(receivedBody.model, 'deepseek-chat');

      assert.deepEqual(events.map(e => e.type), ['reasoning', 'content', 'search_results', 'finish']);
      assert.equal(events[0].delta, '思考中');
      assert.equal(events[1].delta, '答案');
      assert.ok(events[2].results);
      assert.equal(events[2].results.results.length, 1);
      assert.equal(events[3].type, 'finish');
    } finally {
      server.close();
    }
  });

  it('sends Authorization header when apiKey is provided', async () => {
    let authHeader = null;
    const { server, url } = await startMockServer((req, res) => {
      authHeader = req.headers['authorization'];
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.end('data: {"choices":[{"delta":{"content":"ok"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n');
    });

    try {
      const provider = new OpenAICompatProvider({ gatewayUrl: url, apiKey: 'secret-token' });
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
      assert.equal(authHeader, 'Bearer secret-token');
      assert.ok(events.some(e => e.type === 'content'));
    } finally {
      server.close();
    }
  });

  it('sends extra custom headers', async () => {
    let sessionKeyHeader = null;
    let agentIdHeader = null;
    const { server, url } = await startMockServer((req, res) => {
      sessionKeyHeader = req.headers['x-openclaw-session-key'];
      agentIdHeader = req.headers['x-openclaw-agent-id'];
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.end('data: {"choices":[{"delta":{"content":"ok"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n');
    });

    try {
      const provider = new OpenAICompatProvider({
        gatewayUrl: url,
        apiKey: 'k',
        headers: {
          'x-openclaw-session-key': 'obsidian-123',
          'x-openclaw-agent-id': 'gray',
        },
      });
      for await (const _ of provider.streamChat({
        messages: [{ role: 'user', content: 'hello' }],
        model: 'deepseek-chat',
        thinking: false,
        search: false,
        signal: new AbortController().signal,
      })) {
        // noop
      }
      assert.equal(sessionKeyHeader, 'obsidian-123');
      assert.equal(agentIdHeader, 'gray');
    } finally {
      server.close();
    }
  });

  it('maps delta.tool_calls to search_results event', async () => {
    const { server, url } = await startMockServer((req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.write('data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"tc1","type":"function","function":{"name":"kimi_search","arguments":"{\\"query\\": \\"syncthing conflict"}}]}}]}\n\n');
      res.write('data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":" resolution\\"}"}}]},"finish_reason":"tool_calls"}]}\n\n');
      res.end('data: [DONE]\n\n');
    });

    try {
      const provider = new OpenAICompatProvider({ gatewayUrl: url });
      const events = [];
      for await (const ev of provider.streamChat({
        messages: [{ role: 'user', content: 'search' }],
        model: 'deepseek-chat',
        thinking: false,
        search: false,
        signal: new AbortController().signal,
      })) {
        events.push(ev);
      }
      assert.ok(events.some(e => e.type === 'search_results'));
      const search = events.find(e => e.type === 'search_results');
      assert.ok(search.results.queries[0].includes('syncthing conflict resolution'));
      assert.ok(events.some(e => e.type === 'finish'));
    } finally {
      server.close();
    }
  });

  it('throws on non-ok gateway response', async () => {
    const { server, url } = await startMockServer((req, res) => {
      res.writeHead(503);
      res.end('busy');
    });

    try {
      const provider = new OpenAICompatProvider({ gatewayUrl: url });
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
      }, /gateway error 503/);
    } finally {
      server.close();
    }
  });

  it('aborts when signal is triggered', async () => {
    const { server, url } = await startMockServer((req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.write('data: {"id":"cmpl-1","object":"chat.completion.chunk","created":1,"model":"deepseek-chat","choices":[{"index":0,"delta":{"content":" partial"}}]}\n\n');
      // 保持连接不结束
      setTimeout(() => res.end(), 5000);
    });

    try {
      const provider = new OpenAICompatProvider({ gatewayUrl: url });
      const controller = new AbortController();
      const events = [];
      const iter = provider.streamChat({
        messages: [{ role: 'user', content: 'abort me' }],
        model: 'deepseek-chat',
        thinking: false,
        search: false,
        signal: controller.signal,
      });

      const consume = (async () => {
        for await (const ev of iter) {
          events.push(ev);
        }
      })();

      await new Promise(r => setTimeout(r, 80));
      controller.abort();
      await assert.rejects(() => consume, /AbortError/);
    } finally {
      server.close();
    }
  });
});
