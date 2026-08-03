// 最小 OpenClaw-compatible mock server（零依赖）
// 仅用于验证 provider 的协议解析与事件收集逻辑。
// 默认 emit TransportEvent 风格事件（ChatChunk / Done）；设置 MOCK_LEGACY=1 可回退到旧 chat 事件。
const http = require('http');
const crypto = require('crypto');

const DEFAULT_PORT = 18791;
const DEFAULT_TOKEN = 'mock-admin-token';

function computeAccept(key) {
  return crypto
    .createHash('sha1')
    .update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11')
    .digest('base64');
}

function parseFrame(buf) {
  if ((buf[0] & 0x0f) !== 0x01) return null; // must be text
  let len = buf[1] & 0x7f;
  let offset = 2;
  if (len === 126) { len = buf.readUInt16BE(2); offset = 4; }
  else if (len === 127) { len = buf.readUInt32BE(6); offset = 10; }
  const masked = !!(buf[1] & 0x80);
  let mask;
  if (masked) { mask = buf.subarray(offset, offset + 4); offset += 4; }
  let payload = buf.subarray(offset, offset + len);
  if (masked) {
    for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i % 4];
  }
  return payload.toString('utf8');
}

function makeFrame(text) {
  const payload = Buffer.from(text, 'utf8');
  let header;
  if (payload.length < 126) header = Buffer.from([0x81, payload.length]);
  else if (payload.length < 65536) {
    header = Buffer.alloc(4);
    header[0] = 0x81; header[1] = 126;
    header.writeUInt16BE(payload.length, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x81; header[1] = 127;
    header.writeUInt32BE(payload.length, 6);
  }
  return Buffer.concat([header, payload]);
}

function send(ws, obj) {
  ws.socket.write(makeFrame(JSON.stringify(obj)));
}

function close(ws, code, reason) {
  const buf = Buffer.allocUnsafe(2 + Buffer.byteLength(reason, 'utf8'));
  buf.writeUInt16BE(code, 0);
  buf.write(reason, 2, 'utf8');
  const frame = Buffer.concat([Buffer.from([0x88, buf.length]), buf]);
  ws.socket.write(frame);
  ws.socket.end();
}

function createMockServer({ port = 0, token = DEFAULT_TOKEN, legacy = false, onConnect, onChat } = {}) {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      res.writeHead(200);
      res.end('OpenClaw mock server');
    });

    server.on('upgrade', (req, socket, head) => {
      const key = req.headers['sec-websocket-key'];
      if (!key) { socket.destroy(); return; }
      socket.write(
        'HTTP/1.1 101 Switching Protocols\r\n' +
        'Upgrade: websocket\r\n' +
        'Connection: Upgrade\r\n' +
        `Sec-WebSocket-Accept: ${computeAccept(key)}\r\n\r\n`
      );

      const ws = { socket, buffer: Buffer.alloc(0), state: 'challenge', chatReqId: null };

      socket.on('data', (chunk) => {
        ws.buffer = Buffer.concat([ws.buffer, chunk]);
        let frame;
        while ((frame = parseFrame(ws.buffer)) !== null) {
          // simplistic: assume single-frame messages; consume whole buffer
          ws.buffer = Buffer.alloc(0);
          handle(ws, frame);
        }
      });

      // send challenge immediately
      send(ws, { type: 'event', event: 'connect.challenge', payload: { nonce: crypto.randomUUID(), ts: Date.now() } });

      function handle(ws, text) {
        let msg;
        try { msg = JSON.parse(text); } catch { return; }
        if (msg.type !== 'req') return;

        if (msg.method === 'connect') {
          const receivedToken = msg.params?.auth?.token;
          if (receivedToken !== token) {
            send(ws, { type: 'res', id: msg.id, ok: false, error: { code: 'UNAUTHORIZED', message: 'bad token' } });
            setTimeout(() => close(ws, 1008, 'bad token'), 50);
            return;
          }
          if (onConnect) onConnect(msg.params);
          send(ws, {
            type: 'res', id: msg.id, ok: true, payload: {
              type: 'hello-ok', protocol: 3,
              server: { version: 'mock', connId: 'c1' },
              features: { methods: ['chat.send', 'chat.history', 'sessions.list'], events: ['chat'] },
              policy: { maxPayload: 26214400, maxBufferedBytes: 52428800, tickIntervalMs: 30000 }
            }
          });
          ws.state = 'connected';
          return;
        }

        if (msg.method === 'chat.send' && ws.state === 'connected') {
          ws.chatReqId = msg.id;
          send(ws, { type: 'res', id: msg.id, ok: true, payload: { runId: 'mock-run', status: 'started' } });
          if (onChat) onChat(msg.params);

          if (legacy) {
            setTimeout(() => send(ws, { type: 'event', event: 'chat', payload: { message: { role: 'assistant', content: 'Hello' } } }), 100);
            setTimeout(() => send(ws, { type: 'event', event: 'chat', payload: { message: { role: 'assistant', content: ' from' } } }), 200);
            setTimeout(() => send(ws, { type: 'event', event: 'chat', payload: { message: { role: 'assistant', content: ' spike.' } } }), 300);
            setTimeout(() => send(ws, { type: 'event', event: 'chat', payload: { done: true } }), 400);
          } else {
            setTimeout(() => send(ws, { type: 'event', event: 'ChatChunk', payload: { delta: { content: 'Hello' } } }), 100);
            setTimeout(() => send(ws, { type: 'event', event: 'ChatChunk', payload: { delta: { content: ' from' } } }), 200);
            setTimeout(() => send(ws, { type: 'event', event: 'ChatChunk', payload: { delta: { content: ' spike.' } } }), 300);
            setTimeout(() => send(ws, { type: 'event', event: 'Done', payload: {} }), 400);
          }
          setTimeout(() => close(ws, 1000, 'done'), 600);
        }
      }
    });

    server.listen(port, '127.0.0.1', () => {
      const addr = server.address();
      resolve({ server, port: addr.port, url: `ws://127.0.0.1:${addr.port}/ws` });
    });
  });
}

if (require.main === module) {
  const port = parseInt(process.env.MOCK_PORT, 10) || DEFAULT_PORT;
  const token = process.env.MOCK_TOKEN || DEFAULT_TOKEN;
  const legacy = process.env.MOCK_LEGACY === '1';
  createMockServer({ port, token, legacy }).then(({ port: actualPort, url }) => {
    console.log(`Mock OpenClaw server listening on ${url}`);
  });
}

module.exports = { createMockServer, DEFAULT_TOKEN, DEFAULT_PORT };
