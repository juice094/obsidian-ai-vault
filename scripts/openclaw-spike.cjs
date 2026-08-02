// OpenClaw 协议最小连通性 spike
// 零依赖，使用 Node.js 内置 WebSocket（Node >= 22）
// 用法：OPENCLAW_URL=ws://127.0.0.1:18790/openclaw/ws OPENCLAW_ADMIN_TOKEN_FILE=/path/to/token node scripts/openclaw-spike.cjs

const fs = require('fs');
const path = require('path');

const url = process.env.OPENCLAW_URL || 'ws://127.0.0.1:18790/openclaw/ws';
const tokenFile = process.env.OPENCLAW_ADMIN_TOKEN_FILE;
if (!tokenFile) {
  console.error('请设置 OPENCLAW_ADMIN_TOKEN_FILE');
  process.exit(1);
}
const token = fs.readFileSync(tokenFile, 'utf8').trim();

const outFile = process.env.OPENCLAW_OUT || path.join(__dirname, '../docs/openclaw-spike-sample.json');

const events = [];
let ws;
let connectReqId = null;
let chatReqId = null;
let state = 'connecting';

function log(kind, payload) {
  const rec = { t: Date.now(), kind, payload };
  events.push(rec);
  console.log(JSON.stringify(rec));
}

function send(obj) {
  const text = JSON.stringify(obj);
  log('>>_sent', { type: obj.type, method: obj.method, id: obj.id });
  ws.send(text);
}

function redactEvents(list) {
  return JSON.parse(JSON.stringify(list, (k, v) => {
    if (typeof v === 'string' && v.length > 16 && (k === 'token' || k === 'signature' || k === 'publicKey' || k === 'device_token')) {
      return v.slice(0, 4) + '…' + v.slice(-4);
    }
    return v;
  }));
}

function isDoneEvent(parsed) {
  if (parsed.event === 'Done') return true;
  if (parsed.event === 'chat' && parsed.payload?.done) return true;
  return false;
}

function connect() {
  ws = new WebSocket(url);

  ws.onopen = () => {
    log('ws_open', { url });
  };

  ws.onmessage = (ev) => {
    const text = ev.data;
    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = { raw: text };
    }
    log('<<_recv', parsed);

    if (parsed.type === 'event' && parsed.event === 'connect.challenge') {
      connectReqId = crypto.randomUUID();
      send({
        type: 'req',
        id: connectReqId,
        method: 'connect',
        params: {
          minProtocol: 3,
          maxProtocol: 3,
          client: {
            id: "gateway-client",
            version: '0.0.1',
            platform: 'win32',
            mode: "cli",
          },
          role: 'operator',
          scopes: ['operator.admin', 'operator.read', 'operator.write', 'operator.approvals', 'operator.pairing'],
          auth: { token },
          caps: [],
        },
      });
      return;
    }

    if (parsed.type === 'res' && parsed.id === connectReqId && parsed.ok) {
      state = 'connected';
      chatReqId = crypto.randomUUID();
      setTimeout(() => {
        send({
          type: 'req',
          id: chatReqId,
          method: 'chat.send',
          params: {
            sessionKey: 'agent:main:main',
            message: [{ type: 'text', text: 'hello from spike' }],
            stream: true,
          },
        });
      }, 200);
      return;
    }

    if (parsed.type === 'res' && parsed.id === chatReqId) {
      if (!parsed.ok) {
        state = 'chat_error';
      }
      return;
    }

    if (parsed.type === 'event' && (parsed.event === 'chat' || parsed.event === 'ChatChunk' || parsed.event === 'ReasoningChunk' || parsed.event === 'Done')) {
      if (isDoneEvent(parsed)) {
        state = 'done';
      }
    }
  };

  ws.onerror = (err) => {
    log('ws_error', { message: err.message || String(err) });
  };

  ws.onclose = (ev) => {
    log('ws_close', { code: ev.code, reason: ev.reason });
    finish();
  };
}

function finish() {
  const payload = {
    url,
    started: events[0]?.t,
    finished: Date.now(),
    finalState: state,
    eventCount: events.length,
    events: redactEvents(events),
  };
  fs.mkdirSync(path.dirname(outFile), { recursive: true });
  fs.writeFileSync(outFile, JSON.stringify(payload, null, 2));
  console.log(`\n采样已写入 ${outFile}，共 ${events.length} 个事件，最终状态 ${state}`);
  process.exit(0);
}

connect();

// 8 秒后主动关闭；若提前收到 done 也关闭
setTimeout(() => {
  if (ws.readyState === WebSocket.OPEN) {
    ws.close(1000, 'spike timeout');
  } else {
    finish();
  }
}, 8000);

let checkDone = setInterval(() => {
  if (state === 'done' || state === 'chat_error') {
    clearInterval(checkDone);
    setTimeout(() => {
      if (ws.readyState === WebSocket.OPEN) ws.close(1000, 'spike complete');
    }, 500);
  }
}, 200);
