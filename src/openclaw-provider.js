// OpenClaw JSON-RPC over WebSocket provider（阶段 1）
// 仅实现 admin token 认证 + ChatChunk/Done 事件映射；不启用工具/审批，不做 Ed25519 配对。

const DEFAULT_CLIENT_ID = 'cli';
const DEFAULT_SESSION_KEY = 'agent:main:main';
const DEFAULT_SCOPES = ['operator.read', 'operator.write'];

export class OpenClawProvider {
  constructor({
    url,
    token,
    clientId = DEFAULT_CLIENT_ID,
    sessionKey = DEFAULT_SESSION_KEY,
    simpleConnect = false,
  }) {
    if (!token) throw new Error('OpenClaw token required');
    this.url = url;
    this.token = token;
    this.clientId = clientId;
    this.sessionKey = sessionKey;
    this.simpleConnect = simpleConnect;
  }

  async *streamChat({ messages, model, thinking, search, signal }) {
    if (signal?.aborted) {
      throw new DOMException('Aborted', 'AbortError');
    }

    const token = this.token;
    const url = this.url;
    const ws = new WebSocket(url);

    const events = [];
    let deferred = null;
    let done = false;
    let error = null;

    const push = (ev) => {
      if (done) return;
      events.push(ev);
      if (deferred) {
        deferred.resolve();
        deferred = null;
      }
    };

    const fail = (err) => {
      if (done) return;
      error = err;
      done = true;
      if (deferred) {
        deferred.reject(err);
        deferred = null;
      }
    };

    const finish = () => {
      if (done) return;
      done = true;
      if (deferred) {
        deferred.resolve();
        deferred = null;
      }
    };

    const onMessage = (ev) => {
      let parsed;
      try {
        parsed = JSON.parse(ev.data);
      } catch {
        return;
      }
      push({ type: 'message', parsed });
    };

    const onError = (err) => {
      fail(new Error(`websocket error: ${err.message || String(err)}`));
    };

    const onClose = () => finish();

    ws.addEventListener('message', onMessage);
    ws.addEventListener('error', onError);
    ws.addEventListener('close', onClose);

    // 真实 OpenClaw gateway 可能使用极简 connect 载荷。
    if (this.simpleConnect) {
      ws.addEventListener('open', () => {
        send({ type: 'connect', token });
      });
    }

    const abortHandler = () => {
      if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) {
        ws.close(1000, 'abort');
      }
      fail(new DOMException('Aborted', 'AbortError'));
    };
    signal?.addEventListener('abort', abortHandler);

    const nextEvent = () => {
      if (events.length) return Promise.resolve(events.shift());
      if (error) return Promise.reject(error);
      if (done) return Promise.resolve(null);
      let resolve, reject;
      const p = new Promise((res, rej) => { resolve = res; reject = rej; });
      deferred = { resolve, reject };
      return p.then(() => {
        if (error) throw error;
        if (events.length) return events.shift();
        return null;
      });
    };

    const send = (obj) => {
      ws.send(JSON.stringify(obj));
    };

    const randId = () => {
      if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
      return `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    };

    const lastUserContent = () => {
      for (let i = messages.length - 1; i >= 0; i--) {
        if (messages[i].role === 'user') return messages[i].content;
      }
      return messages[messages.length - 1]?.content || '';
    };

    try {
      if (!this.simpleConnect) {
        // 1. 等待 connect.challenge（clarity-gateway 方言）
        while (true) {
          const msg = await nextEvent();
          if (!msg) throw new Error('OpenClaw connection closed before challenge');
          const { parsed } = msg;
          if (parsed.type === 'event' && parsed.event === 'connect.challenge') {
            const connectReqId = randId();
            send({
              type: 'req',
              id: connectReqId,
              method: 'connect',
              params: {
                minProtocol: 3,
                maxProtocol: 3,
                client: {
                  id: this.clientId,
                  version: '1.0.0',
                  platform: 'linux',
                  mode: 'cli',
                },
                role: 'operator',
                scopes: DEFAULT_SCOPES,
                auth: { token },
                caps: [],
              },
            });
            break;
          }
        }
      }

      // 2. 等待 hello-ok 等价确认
      while (true) {
        const msg = await nextEvent();
        if (!msg) throw new Error('OpenClaw connection closed before hello-ok');
        const { parsed } = msg;
        if (this._isConnectError(parsed)) {
          throw new Error(`OpenClaw connect failed: ${parsed.error?.message || parsed.message || 'unknown'}`);
        }
        if (this._isHelloOk(parsed)) break;
      }

      // 3. 发送 chat.send（真实 OpenClaw gateway 格式）
      const chatReqId = randId();
      send({
        type: 'req',
        id: chatReqId,
        method: 'chat.send',
        params: {
          idempotencyKey: randId(),
          sessionKey: this.sessionKey,
          message: lastUserContent(),
        },
      });

      // 4. 消费事件流
      let finished = false;
      while (!finished) {
        const msg = await nextEvent();
        if (!msg) break; // 连接关闭且无更多事件
        const { parsed } = msg;

        if (parsed.type === 'res' && parsed.id === chatReqId) {
          if (!parsed.ok) {
            throw new Error(`OpenClaw chat.send failed: ${parsed.error?.message || 'unknown'}`);
          }
          continue;
        }

        const ev = this._mapEvent(parsed);
        if (ev) {
          yield ev;
          if (ev.type === 'finish') finished = true;
        }
      }
    } finally {
      signal?.removeEventListener('abort', abortHandler);
      if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) {
        ws.close(1000, 'stream end');
      }
    }
  }

  _isHelloOk(parsed) {
    if (!parsed || typeof parsed !== 'object') return false;
    if (parsed.type === 'res' && parsed.ok && parsed.payload?.type === 'hello-ok') return true;
    if (this.simpleConnect) {
      // 真实 gateway 方言未知，接受若干 hello-ok 等价形式。
      if (parsed.type === 'hello-ok' || parsed.type === 'connected') return true;
      if (parsed.event === 'hello-ok' || parsed.event === 'connected') return true;
      if (parsed.type === 'res' && parsed.ok) return true;
    }
    return false;
  }

  _isConnectError(parsed) {
    if (!parsed || typeof parsed !== 'object') return false;
    if (parsed.type === 'res' && parsed.ok === false) return true;
    if (this.simpleConnect && (parsed.type === 'error' || parsed.error)) return true;
    return false;
  }

  _mapEvent(parsed) {
    const event = parsed.event;
    const payload = parsed.payload;
    if (!payload) return null;

    if (event === 'ChatChunk' || event === 'chat') {
      const delta = payload.delta;
      if (delta) {
        if (delta.content) return { type: 'content', delta: delta.content };
        if (delta.reasoning) return { type: 'reasoning', delta: delta.reasoning };
        if (delta.text) return { type: 'content', delta: delta.text };
      }
      if (payload.message?.content) {
        return { type: 'content', delta: payload.message.content };
      }
      if (payload.content) {
        return { type: 'content', delta: payload.content };
      }
    }

    if (event === 'ReasoningChunk') {
      const delta = payload.delta;
      if (delta) {
        if (delta.reasoning) return { type: 'reasoning', delta: delta.reasoning };
        if (delta.content) return { type: 'reasoning', delta: delta.content };
        if (delta.text) return { type: 'reasoning', delta: delta.text };
      }
      if (payload.reasoning) return { type: 'reasoning', delta: payload.reasoning };
      if (payload.message?.content) return { type: 'reasoning', delta: payload.message.content };
    }

    // 真实 OpenClaw gateway 用 agent 事件推送 assistant 流式文本。
    if (event === 'agent') {
      const data = payload.data;
      // lifecycle end 标志本轮结束
      if (payload.stream === 'lifecycle' && data?.phase === 'end') {
        return { type: 'finish' };
      }
      if (data) {
        if (payload.stream === 'reasoning' || payload.stream === 'think') {
          if (data.delta) return { type: 'reasoning', delta: data.delta };
          if (data.text) return { type: 'reasoning', delta: data.text };
        }
        if (data.delta) return { type: 'content', delta: data.delta };
        if (data.text) return { type: 'content', delta: data.text };
      }
      if (payload.done === true || payload.finished === true) {
        return { type: 'finish' };
      }
    }

    // OpenClaw 同时推送 chat 事件（delta / final）。
    if (event === 'chat') {
      if (payload.state === 'final') return { type: 'finish' };
      const content = payload.message?.content;
      if (typeof content === 'string') return { type: 'content', delta: content };
      if (Array.isArray(content)) {
        const text = content.filter(c => c.type === 'text').map(c => c.text).join('');
        if (text) return { type: 'content', delta: text };
      }
    }

    if (event === 'Done' || payload.done === true) {
      return { type: 'finish' };
    }

    if (payload.search_results) {
      return { type: 'search_results', results: payload.search_results };
    }

    return null;
  }
}
