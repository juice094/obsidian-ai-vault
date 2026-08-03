// W17b: 桌面端路由 B（OpenClaw HTTP）真实会话冒烟。
// 使用 OpenAICompatProvider 指向远程 HTTP 端点，验证一轮真实流式会话。
// 凭证从 claw-cred.txt 读取，不进提交。

import { readFileSync, writeFileSync } from 'node:fs';
import { SessionEngine } from '../src/engine.js';
import { OpenAICompatProvider } from '../src/openai-compat-provider.js';

const credPath = new URL('../claw-cred.txt', import.meta.url);
const lines = readFileSync(credPath, 'utf8').split(/\r?\n/);
let openclawUrl = 'http://100.69.11.71:18789';
let openclawToken = '';
for (const line of lines) {
  if (line.startsWith('token:')) openclawToken = line.slice('token:'.length).trim();
}

const argUrl = process.argv.find(a => a.startsWith('http://') || a.startsWith('https://'));
if (argUrl) openclawUrl = argUrl.replace(/\/$/, '');

if (!openclawToken) {
  console.error('无法从 claw-cred.txt 解析 token');
  process.exit(1);
}

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

const vaultIO = makeVaultIO();
const events = [];

const engine = new SessionEngine({
  model: 'openclaw/default',
  thinking: false,
  search: false,
  vaultIO,
  provider: new OpenAICompatProvider({ gatewayUrl: openclawUrl, apiKey: openclawToken }),
  route: 'openclaw',
  onEvent: (e) => events.push(e),
});

console.log('openclawUrl:', openclawUrl);
console.log('model:', engine.model);
console.log('route:', engine.route);

try {
  await engine.send('用一句话问候我。');
  const md = vaultIO._files.get(engine.sessionPath);
  const metaMatch = md.match(/<!-- turn:\d+[^>]*>/);

  console.log('\n--- session path ---');
  console.log(engine.sessionPath);
  console.log('\n--- turn meta ---');
  console.log(metaMatch ? metaMatch[0] : '(no meta)');
  console.log('\n--- md tail ---');
  console.log(md.slice(-400));
  console.log('\n--- events ---');
  console.log(events.map((e) => e.type).join(', '));

  const ok = events.some(e => e.type === 'turn-done') && md.includes('route=openclaw');

  const report = {
    openclawUrl,
    sessionPath: engine.sessionPath,
    meta: metaMatch ? metaMatch[0] : null,
    events: events.map(e => e.type),
    hasRouteMeta: md.includes('route=openclaw'),
    ok,
    testedAt: new Date().toISOString(),
  };
  writeFileSync(new URL('../docs/w17b-smoke-report.json', import.meta.url), JSON.stringify(report, null, 2), 'utf8');
  console.log('\nreport saved to docs/w17b-smoke-report.json');

  process.exit(ok ? 0 : 1);
} catch (err) {
  console.error('send failed:', err.message || String(err));
  process.exit(1);
}
