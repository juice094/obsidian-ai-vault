// W17b/W18a: 桌面端路由 B（OpenClaw HTTP）真实会话冒烟。
// 默认跑两轮：第一轮给随机数，第二轮问回，验证 session key 上下文保持。
// 用法：node scripts/w17b-smoke.mjs [http://100.69.11.71:18789] [--main]

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
const useMainEntry = process.argv.includes('--main');
const useDevice = process.argv.includes('--device');

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
const randomNumber = Math.floor(Math.random() * 1000000).toString();
const peerAgent = useDevice ? 'device' : 'main';
const sessionEntry = useMainEntry ? 'main' : 'note';

const engine = new SessionEngine({
  model: 'openclaw/default',
  thinking: false,
  search: false,
  vaultIO,
  provider: new OpenAICompatProvider({ gatewayUrl: openclawUrl, apiKey: openclawToken }),
  route: 'openclaw',
  sessionEntry,
  peerAgent,
  tokenBudgetChars: 48000,
  onEvent: (e) => events.push(e),
});

console.log('openclawUrl:', openclawUrl);
console.log('model:', engine.model);
console.log('route:', engine.route);
console.log('peerAgent:', engine.peerAgent);
console.log('sessionEntry:', engine.sessionEntry);
console.log('sessionKey:', engine.sessionKey);
console.log('randomNumber:', randomNumber);

try {
  // Round 1: give random number
  await engine.send(`请记住这个数字：${randomNumber}。只回复“已记住”。`);

  // Round 2: ask it back
  const round2Events = [];
  engine.onEvent = (e) => round2Events.push(e);
  await engine.send('我刚才让你记住的数字是多少？');

  const md = vaultIO._files.get(engine.sessionPath);
  const metaMatch = md.match(/<!-- turn:\d+[^>]*>/g);

  console.log('\n--- session path ---');
  console.log(engine.sessionPath);
  console.log('\n--- turn metas ---');
  console.log(metaMatch ? metaMatch.join('\n') : '(no meta)');
  console.log('\n--- md tail ---');
  console.log(md.slice(-600));
  console.log('\n--- events ---');
  console.log(events.map((e) => e.type).join(', '));
  console.log('\n--- round 2 events ---');
  console.log(round2Events.map((e) => e.type).join(', '));

  const lastAiBlock = md.match(/<!-- ai:begin id=\d+ -->\n\n([\s\S]*?)\n\n<!-- ai:end -->$/);
  const answerText = (lastAiBlock ? lastAiBlock[1] : '').toLowerCase();
  const remembered = answerText.includes(randomNumber);

  const report = {
    openclawUrl,
    sessionKey: engine.sessionKey,
    sessionPath: engine.sessionPath,
    metas: metaMatch,
    randomNumber,
    remembered,
    events: events.map(e => e.type),
    round2Events: round2Events.map(e => e.type),
    hasRouteMeta: md.includes('route=openclaw'),
    ok: remembered && md.includes('route=openclaw'),
    testedAt: new Date().toISOString(),
  };
  writeFileSync(new URL('../docs/w18a-smoke-report.json', import.meta.url), JSON.stringify(report, null, 2), 'utf8');
  console.log('\nreport saved to docs/w18a-smoke-report.json');

  process.exit(report.ok ? 0 : 1);
} catch (err) {
  console.error('send failed:', err.message || String(err));
  process.exit(1);
}
