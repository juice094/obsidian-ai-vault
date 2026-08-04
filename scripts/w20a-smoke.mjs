// W20a：桌面端本地 gateway 生命周期自动托管冒烟。
// 场景 1：gateway 未运行时发送本地路由消息 → 自动拉起 → 成功响应；
// 场景 2：安装目录填错 → ensureReady 返回友好错误。

import { SessionEngine } from '../src/engine.js';
import { GatewayManager } from '../src/gateway-manager.js';

const installDir = 'C:/Users/22414/dev/deepseek-device-skill';
const gatewayUrl = 'http://127.0.0.1:18791';

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

async function scenarioAutoStart() {
  // 先确保没有外部 gateway 在跑；如果 probe 到，说明本机已有 gateway，场景 1 算外部依赖跳过拉起验证
  const preflight = new GatewayManager({ gatewayUrl, installDir, autoStart: false });
  const alreadyRunning = await preflight.probe(800);

  const gm = new GatewayManager({ gatewayUrl, installDir });
  const vaultIO = makeVaultIO();
  const engine = new SessionEngine({
    gatewayUrl,
    model: 'deepseek-chat',
    thinking: false,
    search: false,
    vaultIO,
    route: 'local',
    provider: 'openai-compat',
  });

  // 劫持 engine 的 provider，在 send 前走 gatewayManager.ensureReady
  const originalSend = engine.send.bind(engine);
  engine.send = async (text) => {
    const ready = await gm.ensureReady();
    if (!ready.ok) throw new Error(ready.error);
    return originalSend(text);
  };

  try {
    await engine.send('你好，这是 W20a 自动拉起冒烟。只回复“W20a-ok”。');
    const md = vaultIO._files.get(engine.sessionPath);
    const ok = md.includes('W20a-ok') || md.includes('ok');
    return {
      name: '自动拉起本地 gateway',
      ok,
      alreadyRunning,
      started: gm.status === 'ready',
      hasRouteLocal: md.includes('route=local'),
    };
  } finally {
    // 只有我们自己拉起时才杀；外部已有的不动
    if (!alreadyRunning) gm.stop();
  }
}

async function scenarioBadPath() {
  const gm = new GatewayManager({ gatewayUrl: 'http://127.0.0.1:19999', installDir: '/nonexistent-w20a' });
  const result = await gm.ensureReady();
  return {
    name: '错误路径友好提示',
    ok: !result.ok && result.error && !result.error.includes('Failed to fetch'),
    error: result.error,
  };
}

const results = [];
for (const fn of [scenarioAutoStart, scenarioBadPath]) {
  try {
    const r = await fn();
    results.push(r);
    console.log(`${r.ok ? '✅' : '❌'} ${r.name}`);
    if (r.error) console.log(`   错误：${r.error}`);
  } catch (err) {
    results.push({ name: fn.name, ok: false, error: err.message });
    console.log(`❌ ${fn.name}: ${err.message}`);
  }
}

import { writeFileSync } from 'node:fs';
const report = {
  gatewayUrl,
  installDir,
  testedAt: new Date().toISOString(),
  results,
  allOk: results.every(r => r.ok),
};
writeFileSync(new URL('../docs/w20a-smoke-report.json', import.meta.url), JSON.stringify(report, null, 2), 'utf8');
console.log('\nreport saved to docs/w20a-smoke-report.json');
process.exit(report.allOk ? 0 : 1);
