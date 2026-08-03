// W14a 桌面路由头对头冒烟脚本
// 用法：
//   路由 A（本地）：node scripts/w14a-smoke.mjs local
//   路由 B（OpenClaw）：OPENCLAW_TOKEN=<token> node scripts/w14a-smoke.mjs openclaw
// 不提交 token：本地 gateway 用明文 HTTP，OpenClaw token 只从环境变量读。

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
  };
}

const route = process.argv[2] || 'local';
const prompt = process.argv[3] || '用一句话问候我，不要搜索。';

const vaultIO = makeVaultIO();
const events = [];

const options = {
  model: 'deepseek-chat',
  thinking: false,
  search: false,
  vaultIO,
  onEvent: (e) => events.push(e),
  route,
};

if (route === 'local') {
  options.gatewayUrl = 'http://127.0.0.1:18791';
  options.provider = 'openai-compat';
} else if (route === 'openclaw') {
  options.openclawUrl = process.env.OPENCLAW_URL || 'ws://100.69.11.71:18789';
  options.openclawToken = process.env.OPENCLAW_TOKEN;
  options.clientId = process.env.OPENCLAW_CLIENT_ID || 'gateway-client';
  options.provider = 'openclaw';
  if (!options.openclawToken) {
    console.error('请设置 OPENCLAW_TOKEN');
    process.exit(1);
  }
} else {
  console.error(`unknown route: ${route}`);
  process.exit(1);
}

const engine = new SessionEngine(options);

try {
  await engine.send(prompt);
  const md = vaultIO._files.get(engine.sessionPath);
  console.log('--- session path ---');
  console.log(engine.sessionPath);
  console.log('--- turn meta ---');
  const metaMatch = md.match(/<!-- turn:\d+[^>]*>/);
  console.log(metaMatch ? metaMatch[0] : '(no meta)');
  console.log('--- md tail ---');
  console.log(md.slice(-400));
  console.log('--- events ---');
  console.log(events.map((e) => e.type).join(', '));
} catch (err) {
  console.error('send failed:', err.message);
  process.exit(1);
}
