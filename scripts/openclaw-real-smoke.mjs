// 真实 OpenClaw gateway 冒烟脚本。
// 凭证从 claw-cred.txt 读取，绝不写进代码或日志。
// 用法：node scripts/openclaw-real-smoke.mjs [simple]

import { readFileSync, writeFileSync } from 'node:fs';
import { setTimeout } from 'node:timers/promises';
import { OpenClawProvider } from '../src/openclaw-provider.js';
import { SessionEngine } from '../src/engine.js';

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
    console.log(`[ws.${direction}]`, JSON.stringify(masked).slice(0, 800));
  } catch {
    capturedFrames.push({ direction, ts: Date.now(), raw: String(raw).slice(0, 400) });
    console.log(`[ws.${direction}]`, String(raw).slice(0, 800));
  }
}

function saveFrames(endpoint) {
  const outPath = new URL('../docs/openclaw-real-smoke-frames.json', import.meta.url);
  const data = { endpoint, capturedAt: new Date().toISOString(), frames: capturedFrames };
  writeFileSync(outPath, JSON.stringify(data, null, 2), 'utf8');
  console.log('\nframes saved to docs/openclaw-real-smoke-frames.json');
}

// 拦截并打印 provider 发出/收到的 WebSocket 帧，用于调试协议方言（token 已打码）。
const origSend = WebSocket.prototype.send;
WebSocket.prototype.send = function (data) {
  logFrame('send', data);
  return origSend.call(this, data);
};

const origAddEventListener = WebSocket.prototype.addEventListener;
WebSocket.prototype.addEventListener = function (type, listener, options) {
  if (type === 'message' && typeof listener === 'function') {
    const wrapped = (ev) => {
      logFrame('recv', ev.data);
      return listener(ev);
    };
    return origAddEventListener.call(this, type, wrapped, options);
  }
  return origAddEventListener.call(this, type, listener, options);
};

const credPath = new URL('../claw-cred.txt', import.meta.url);
const lines = readFileSync(credPath, 'utf8').split(/\r?\n/);
let endpoint = '';
let token = '';
for (const line of lines) {
  if (line.startsWith('endpoint:')) endpoint = line.slice('endpoint:'.length).trim();
  if (line.startsWith('token:')) token = line.slice('token:'.length).trim();
}
if (!token) {
  console.error('无法从 claw-cred.txt 解析 token');
  process.exit(1);
}

// 支持通过环境变量或命令行参数覆盖 endpoint（例如 Tailscale 内网地址）。
const argEndpoint = process.argv.find(a => a.startsWith('ws://') || a.startsWith('wss://'));
endpoint = argEndpoint || process.env.OPENCLAW_ENDPOINT || endpoint;
if (!endpoint) {
  console.error('无法从 claw-cred.txt 或命令行/环境变量获取 endpoint');
  process.exit(1);
}

const simpleConnect = process.argv.includes('simple');
console.log('mode:', simpleConnect ? 'simpleConnect' : 'clarity');
console.log('endpoint:', endpoint);

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
    mkdir: async () => {},
    _files: files,
  };
}

async function runProvider() {
  const provider = new OpenClawProvider({
    url: endpoint,
    token,
    // 使用 provider 默认值 'cli'，匹配真实 OpenClaw gateway 白名单
    sessionKey: 'agent:main:main',
    simpleConnect,
  });

  const events = [];
  const ac = new AbortController();
  const timeout = setTimeout(15000, () => ac.abort(), { ref: false });

  try {
    for await (const ev of provider.streamChat({
      messages: [{ role: 'user', content: '你好，这是一条冒烟测试消息。' }],
      model: 'deepseek-chat',
      thinking: false,
      search: false,
      signal: ac.signal,
    })) {
      events.push(ev);
      if (ev.type === 'content' || ev.type === 'reasoning') {
        process.stdout.write(ev.delta);
      }
      if (ev.type === 'finish') break;
    }
    console.log('\nprovider events:', events.map(e => e.type));
    return { ok: events.some(e => e.type === 'finish'), events };
  } catch (err) {
    console.error('\nprovider error:', err.message || String(err));
    return { ok: false, error: err.message || String(err), events };
  } finally {
    clearTimeout(timeout);
  }
}

async function runEngine() {
  const vaultIO = makeVaultIO();
  const engineEvents = [];
  const engine = new SessionEngine({
    provider: new OpenClawProvider({
      url: endpoint,
      token,
      // 使用 provider 默认值 'cli'，匹配真实 OpenClaw gateway 白名单
      sessionKey: 'agent:main:main',
      simpleConnect,
    }),
    model: 'deepseek-chat',
    thinking: false,
    search: false,
    vaultIO,
    onEvent: (e) => engineEvents.push(e),
  });

  try {
    await engine.send('你好，这是通过 SessionEngine 的真实 gateway 冒烟测试。');
    const md = vaultIO._files.get(engine.sessionPath);
    console.log('session path:', engine.sessionPath);
    console.log('engine events:', engineEvents.map(e => e.type));
    console.log('md length:', md?.length ?? 0);
    return { ok: engineEvents.some(e => e.type === 'turn-done'), md, engineEvents };
  } catch (err) {
    console.error('engine error:', err.message || String(err));
    return { ok: false, error: err.message || String(err) };
  }
}

const result = await runProvider();
if (result.ok) {
  console.log('\n--- provider 单独通过，尝试 SessionEngine 集成 ---');
  await runEngine();
} else {
  console.log('\n--- provider 未通过，跳过 engine 集成 ---');
}
saveFrames(endpoint);
