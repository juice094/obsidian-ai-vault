// OpenClaw 一次性设备配对引导脚本（R4b）。
// 产物 device operator token 追加到 claw-cred.txt，不进提交。
// 用法：node scripts/openclaw-pair.mjs ws://100.69.11.71:18789

import { readFileSync, appendFileSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { webcrypto } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';

const subtle = webcrypto.subtle;

const credPath = new URL('../claw-cred.txt', import.meta.url);
const lines = readFileSync(credPath, 'utf8').split(/\r?\n/);
let endpoint = '';
let adminToken = '';
for (const line of lines) {
  if (line.startsWith('endpoint:')) endpoint = line.slice('endpoint:'.length).trim();
  if (line.startsWith('token:')) adminToken = line.slice('token:'.length).trim();
}

const argEndpoint = process.argv.find(a => a.startsWith('ws://') || a.startsWith('wss://'));
endpoint = argEndpoint || process.env.OPENCLAW_ENDPOINT || endpoint;

if (!endpoint || !adminToken) {
  console.error('无法从 claw-cred.txt 或命令行解析 endpoint/adminToken');
  process.exit(1);
}

const DEVICE_ID = process.env.OPENCLAW_DEVICE_ID || `obsidian-ai-vault-${randomUUID()}`;
const DEVICE_FAMILY = process.env.OPENCLAW_DEVICE_FAMILY || 'Desktop';
const PLATFORM = process.env.OPENCLAW_PLATFORM || 'linux';
const CLIENT_MODE = 'cli';
const ROLE = 'operator';
const SCOPES = ['operator.read', 'operator.write'];
const ADMIN_SCOPES = ['operator.read', 'operator.write', 'operator.pairing'];

const capturedFrames = [];

function maskToken(obj) {
  const masked = JSON.parse(JSON.stringify(obj));
  if (masked.params?.auth?.token) masked.params.auth.token = '***';
  if (masked.token) masked.token = '***';
  for (const key of Object.keys(masked)) {
    if (/token|secret|key|password|credential/i.test(key) && typeof masked[key] === 'string') {
      masked[key] = '***';
    }
  }
  return masked;
}

function logFrame(direction, raw) {
  try {
    const parsed = JSON.parse(raw);
    const masked = maskToken(parsed);
    capturedFrames.push({ direction, ts: Date.now(), frame: masked });
  } catch {
    capturedFrames.push({ direction, ts: Date.now(), raw: String(raw).slice(0, 400) });
  }
}

class WsClient {
  constructor(url, { token, clientId = 'cli' } = {}) {
    this.url = url;
    this.token = token;
    this.clientId = clientId;
    this.ws = null;
    this.reqId = 0;
    this.pending = new Map();
    this.eventHandlers = [];
    this.frames = [];
  }

  async connect() {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(this.url);
      this.ws = ws;
      let settled = false;
      const timer = setTimeout(() => reject(new Error('websocket open timeout')), 15000);

      ws.addEventListener('open', () => {
        clearTimeout(timer);
        if (settled) return;
        settled = true;
        resolve();
      });

      ws.addEventListener('error', (err) => {
        clearTimeout(timer);
        if (settled) return;
        settled = true;
        reject(new Error(`websocket error: ${err.message || String(err)}`));
      });

      ws.addEventListener('close', () => {
        clearTimeout(timer);
        if (settled) return;
        settled = true;
        reject(new Error('websocket closed before open'));
      });

      ws.addEventListener('message', (ev) => this._onMessage(ev.data));
    });
  }

  _onMessage(data) {
    logFrame('recv', data);
    let parsed;
    try {
      parsed = JSON.parse(data);
    } catch {
      return;
    }
    if (parsed.id && this.pending.has(parsed.id)) {
      const { resolve } = this.pending.get(parsed.id);
      this.pending.delete(parsed.id);
      resolve(parsed);
      return;
    }
    for (const h of this.eventHandlers) {
      try { h(parsed); } catch {}
    }
  }

  _send(obj) {
    const raw = JSON.stringify(obj);
    logFrame('send', raw);
    this.ws.send(raw);
  }

  send(method, params) {
    const id = `${++this.reqId}-${Date.now()}`;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this._send({ type: 'req', id, method, params });
    });
  }

  onEvent(handler) {
    this.eventHandlers.push(handler);
    return () => {
      const idx = this.eventHandlers.indexOf(handler);
      if (idx >= 0) this.eventHandlers.splice(idx, 1);
    };
  }

  close() {
    if (this.ws && (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING)) {
      this.ws.close(1000, 'done');
    }
  }
}

async function doConnect(token, clientId, scopes = SCOPES) {
  const client = new WsClient(endpoint, { token, clientId });
  await client.connect();

  // 等待 challenge
  let challenge;
  const remove = client.onEvent((parsed) => {
    if (parsed.type === 'event' && parsed.event === 'connect.challenge') {
      challenge = parsed;
    }
  });

  for (let i = 0; i < 50 && !challenge; i++) await sleep(100);
  remove();
  if (!challenge) throw new Error('no connect.challenge received');

  const signedAt = new Date().toISOString();
  const connectParams = {
    minProtocol: 3,
    maxProtocol: 3,
    client: {
      id: clientId,
      version: '1.0.0',
      platform: PLATFORM,
      mode: CLIENT_MODE,
    },
    role: ROLE,
    scopes,
    auth: { token },
    caps: [],
  };

  const helloOk = await client.send('connect', connectParams);
  if (!helloOk.ok) {
    throw new Error(`connect failed: ${helloOk.error?.message || JSON.stringify(helloOk.error)}`);
  }
  return { client, helloOk, challenge };
}

async function generateEd25519Key() {
  const keyPair = await subtle.generateKey('Ed25519', true, ['sign', 'verify']);
  const pub = await subtle.exportKey('raw', keyPair.publicKey);
  const priv = await subtle.exportKey('pkcs8', keyPair.privateKey);
  const publicKeyB64 = Buffer.from(pub).toString('base64');
  const privateKeyB64 = Buffer.from(priv).toString('base64');
  return { publicKeyB64, privateKeyB64, keyPair };
}

async function signPairingPayload(keyPair, { deviceId, clientId, nonce, signedAt }) {
  const payloadStr = [
    'v3',
    deviceId,
    clientId,
    CLIENT_MODE,
    ROLE,
    SCOPES.join(','),
    signedAt,
    adminToken,
    nonce,
    PLATFORM,
    DEVICE_FAMILY,
  ].join('|');
  const sig = await subtle.sign('Ed25519', keyPair.privateKey, Buffer.from(payloadStr, 'utf8'));
  return Buffer.from(sig).toString('base64');
}

async function requestPairing() {
  const { client, helloOk, challenge } = await doConnect(adminToken, 'cli', ADMIN_SCOPES);
  console.log('admin connect hello-ok auth.scopes:', JSON.stringify(helloOk.payload?.auth?.scopes));

  try {
    const features = helloOk.payload?.features || {};
    const canAutoApprove = (features.methods || []).includes('node.pair.approve');

    const { publicKeyB64, privateKeyB64, keyPair } = await generateEd25519Key();
    const nonce = challenge.payload?.nonce || randomUUID();
    const signedAt = new Date().toISOString();
    const signatureB64 = await signPairingPayload(keyPair, {
      deviceId: DEVICE_ID,
      clientId: 'cli',
      nonce,
      signedAt,
    });

    // 尝试 node.pair.request 的最小格式
    const pairReq = await client.send('node.pair.request', {
      device: {
        id: DEVICE_ID,
        publicKey: publicKeyB64,
        signature: signatureB64,
        nonce,
        signedAt,
      },
      client: {
        id: 'cli',
        version: '1.0.0',
        platform: PLATFORM,
        mode: CLIENT_MODE,
      },
      role: ROLE,
      scopes: SCOPES,
    });

    console.log('node.pair.request response ok:', pairReq.ok);
    if (!pairReq.ok) {
      console.error('node.pair.request failed:', pairReq.error?.message || JSON.stringify(pairReq.error));
      return { client, helloOk, pairReq, privateKeyB64, publicKeyB64 };
    }

    // 等待/触发批准
    let deviceToken = null;
    let pairList = null;

    if (canAutoApprove) {
      console.log('node.pair.approve in whitelist; attempting auto-approve');
      const approveReq = await client.send('node.pair.approve', { deviceId: DEVICE_ID });
      console.log('auto-approve response:', approveReq.ok, approveReq.error?.message);
    } else {
      console.log('node.pair.approve NOT in whitelist; waiting for dashboard approval (30s)...');
    }

    // 轮询 node.pair.list 最多 60s
    for (let i = 0; i < 60 && !deviceToken; i++) {
      pairList = await client.send('node.pair.list', {});
      const approved = (pairList.payload?.devices || pairList.payload?.pairs || pairList.payload || [])
        .find?.(d => d.id === DEVICE_ID || d.deviceId === DEVICE_ID || d.publicKey === publicKeyB64);
      if (approved?.token) {
        deviceToken = approved.token;
        break;
      }
      if (approved?.status === 'approved' && approved?.operatorToken) {
        deviceToken = approved.operatorToken;
        break;
      }
      await sleep(1000);
    }

    return { client, helloOk, pairReq, pairList, deviceToken, privateKeyB64, publicKeyB64 };
  } finally {
    client.close();
  }
}

async function chatWithDeviceToken(deviceToken) {
  const { client, helloOk } = await doConnect(deviceToken, 'gateway-client');
  console.log('device connect hello-ok auth.scopes:', JSON.stringify(helloOk.payload?.auth?.scopes));

  if (!helloOk.payload?.auth?.scopes?.includes('operator.write')) {
    console.warn('hello-ok 未授予 operator.write');
  }

  const events = [];
  const chatRes = await client.send('chat.send', {
    sessionKey: 'agent:main:main',
    message: [{ type: 'text', text: '你好，这是设备配对后的第一轮真实流式测试。' }],
    stream: true,
  });
  console.log('chat.send response ok:', chatRes.ok);
  if (!chatRes.ok) {
    console.error('chat.send failed:', chatRes.error?.message);
    client.close();
    return { events, chatRes };
  }

  // 消费事件流，最多 60s
  const finish = new Promise((resolve) => {
    const timer = setTimeout(() => resolve(), 60000);
    const remove = client.onEvent((parsed) => {
      const ev = mapEvent(parsed);
      if (ev) {
        events.push(ev);
        if (ev.type === 'content' || ev.type === 'reasoning') process.stdout.write(ev.delta);
        if (ev.type === 'finish') {
          clearTimeout(timer);
          remove();
          resolve();
        }
      }
    });
  });

  await finish;
  client.close();
  return { events, chatRes };
}

function mapEvent(parsed) {
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
    if (payload.message?.content) return { type: 'content', delta: payload.message.content };
    if (payload.content) return { type: 'content', delta: payload.content };
  }

  if (event === 'ReasoningChunk') {
    const delta = payload.delta;
    if (delta) {
      if (delta.reasoning) return { type: 'reasoning', delta: delta.reasoning };
      if (delta.content) return { type: 'reasoning', delta: delta.content };
      if (delta.text) return { type: 'reasoning', delta: delta.text };
    }
    if (payload.reasoning) return { type: 'reasoning', delta: payload.reasoning };
  }

  if (event === 'agent') {
    const data = payload.data;
    if (data) {
      if (payload.stream === 'reasoning' || payload.stream === 'think') {
        if (data.delta) return { type: 'reasoning', delta: data.delta };
        if (data.text) return { type: 'reasoning', delta: data.text };
      }
      if (data.delta) return { type: 'content', delta: data.delta };
      if (data.text) return { type: 'content', delta: data.text };
    }
    if (payload.done === true || payload.finished === true) return { type: 'finish' };
  }

  if (event === 'Done' || payload.done === true) return { type: 'finish' };
  return null;
}

function saveFrames(extra = {}) {
  const outPath = new URL('../docs/openclaw-real-smoke-frames.json', import.meta.url);
  const data = { endpoint, capturedAt: new Date().toISOString(), ...extra, frames: capturedFrames };
  writeFileSync(outPath, JSON.stringify(data, null, 2), 'utf8');
  console.log('\nframes saved to docs/openclaw-real-smoke-frames.json');
}

function appendDeviceToken(deviceToken) {
  const line = `\n# OpenClaw device operator token（R4b 生成，${new Date().toISOString()}）\ndeviceToken: ${deviceToken}\n`;
  appendFileSync(credPath, line, 'utf8');
  console.log('device token appended to claw-cred.txt');
}

// 主流程
console.log('R4b pair flow start');
console.log('endpoint:', endpoint);
console.log('deviceId:', DEVICE_ID);

const pairResult = await requestPairing();
if (!pairResult.deviceToken) {
  console.error('\n未获取到 device token，流程终止。');
  saveFrames({ step: 'pair-request-failed', deviceId: DEVICE_ID });
  process.exit(1);
}

console.log('\n获取到 device token（长度）:', pairResult.deviceToken.length);
appendDeviceToken(pairResult.deviceToken);

const chatResult = await chatWithDeviceToken(pairResult.deviceToken);
console.log('\nchat events:', chatResult.events.map(e => e.type));
const ok = chatResult.events.some(e => e.type === 'finish');
saveFrames({ step: 'pair-and-chat', deviceId: DEVICE_ID, chatOk: ok });

if (ok) {
  console.log('\nR4b 成功：设备配对 + 一轮真实流式 chat 完成。');
} else {
  console.error('\nR4b chat 未收到 finish 事件。');
  process.exit(1);
}
