// W18b：桌面端对侧身份 UX 的 HTTP 面 plumbing 冒烟。
// 跑三个场景：笔记会话随机数、主会话挂接 key、device 身份 header；
// 验证 turn meta 含 route+agent+entry。
// 用法：node scripts/w18b-smoke.mjs [http://100.69.11.71:18789]

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

function makeEngine({ peerAgent, sessionEntry }) {
  return new SessionEngine({
    model: 'openclaw/default',
    thinking: false,
    search: false,
    vaultIO: makeVaultIO(),
    provider: new OpenAICompatProvider({ gatewayUrl: openclawUrl, apiKey: openclawToken }),
    route: 'openclaw',
    peerAgent,
    sessionEntry,
    tokenBudgetChars: 48000,
  });
}

async function scenarioNoteSession() {
  const randomNumber = Math.floor(Math.random() * 1000000).toString();
  const engine = makeEngine({ peerAgent: 'main', sessionEntry: 'note' });
  await engine.send(`请记住这个数字：${randomNumber}。只回复“已记住”。`);
  await engine.send('我刚才让你记住的数字是多少？');
  const md = engine.vaultIO._files.get(engine.sessionPath);
  const lastAiBlock = md.match(/<!-- ai:begin id=\d+ -->\n\n([\s\S]*?)\n\n<!-- ai:end -->$/);
  const answerText = (lastAiBlock ? lastAiBlock[1] : '').toLowerCase();
  return {
    name: '笔记会话随机数',
    ok: answerText.includes(randomNumber) && md.includes('route=openclaw') && md.includes('agent=main') && md.includes('entry=note'),
    sessionKey: engine.sessionKey,
    remembered: answerText.includes(randomNumber),
    hasRouteMeta: md.includes('route=openclaw'),
    hasAgentMeta: md.includes('agent=main'),
    hasEntryMeta: md.includes('entry=note'),
  };
}

async function scenarioMainEntry() {
  const engine = makeEngine({ peerAgent: 'main', sessionEntry: 'main' });
  await engine.send('你好，这是主会话挂接测试。');
  const md = engine.vaultIO._files.get(engine.sessionPath);
  return {
    name: '主会话挂接',
    ok: engine.sessionKey === 'agent:main:main' && md.includes('route=openclaw') && md.includes('agent=main') && md.includes('entry=main'),
    sessionKey: engine.sessionKey,
    hasRouteMeta: md.includes('route=openclaw'),
    hasAgentMeta: md.includes('agent=main'),
    hasEntryMeta: md.includes('entry=main'),
  };
}

async function scenarioDevice() {
  const engine = makeEngine({ peerAgent: 'device', sessionEntry: 'note' });
  await engine.send('你好，这是 device 身份测试。');
  const md = engine.vaultIO._files.get(engine.sessionPath);
  return {
    name: 'device 身份',
    ok: md.includes('route=openclaw') && md.includes('agent=device') && md.includes('entry=note'),
    sessionKey: engine.sessionKey,
    hasRouteMeta: md.includes('route=openclaw'),
    hasAgentMeta: md.includes('agent=device'),
    hasEntryMeta: md.includes('entry=note'),
  };
}

const results = [];
for (const fn of [scenarioNoteSession, scenarioMainEntry, scenarioDevice]) {
  try {
    const r = await fn();
    results.push(r);
    console.log(`${r.ok ? '✅' : '❌'} ${r.name}`);
  } catch (err) {
    results.push({ name: fn.name, ok: false, error: err.message });
    console.log(`❌ ${fn.name}: ${err.message}`);
  }
}

const report = {
  openclawUrl,
  testedAt: new Date().toISOString(),
  results,
  allOk: results.every(r => r.ok),
};
writeFileSync(new URL('../docs/w18b-smoke-report.json', import.meta.url), JSON.stringify(report, null, 2), 'utf8');
console.log('\nreport saved to docs/w18b-smoke-report.json');
process.exit(report.allOk ? 0 : 1);
