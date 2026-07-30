// 真实 gateway 冒烟脚本。
// 用法（凭证从环境变量读取，绝不写进仓库）：
//   DEEPSEEK_MOBILE=... DEEPSEEK_PASSWORD=... node scripts/smoke-real-gateway.js
//
// 本脚本会：
// 1. 启动本地 deepseek-device-skill serve（fast+search 模式）；
// 2. 用 SessionEngine 聊 2 轮；
// 3. 把最终 md 写入 samples/ 目录供人工审阅。

import { spawn } from 'node:child_process';
import { setTimeout } from 'node:timers/promises';
import fs from 'node:fs/promises';
import { SessionEngine } from '../src/engine.js';

const GATEWAY_PORT = 18792;
const mobile = process.env.DEEPSEEK_MOBILE;
const password = process.env.DEEPSEEK_PASSWORD;

if (!mobile || !password) {
  console.error('需要环境变量 DEEPSEEK_MOBILE 和 DEEPSEEK_PASSWORD');
  process.exit(1);
}

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

async function waitForGateway(url, retries = 30) {
  for (let i = 0; i < retries; i++) {
    try {
      const res = await fetch(`${url}/health`);
      if (res.ok) return;
    } catch {}
    await setTimeout(500);
  }
  throw new Error('gateway did not start');
}

async function main() {
  const ddsPath = 'C:/Users/22414/dev/deepseek-device-skill/target/release/deepseek-device-skill.exe';
  const childEnv = { ...process.env };
  delete childEnv.DEEPSEEK_DEVICE_TOKEN;
  const proc = spawn(ddsPath, [
    'serve',
    '--model', 'fast',
    '--search',
    '--mobile', mobile,
    '--password', password,
    '--port', String(GATEWAY_PORT),
  ], { stdio: 'pipe', env: childEnv });

  proc.stderr.on('data', d => process.stderr.write(d));
  const url = `http://127.0.0.1:${GATEWAY_PORT}`;
  await waitForGateway(url);
  console.log('gateway ready');

  const vaultIO = makeVaultIO();
  const events = [];
  const engine = new SessionEngine({
    gatewayUrl: url,
    model: 'deepseek-chat',
    thinking: false,
    search: true,
    vaultIO,
    onEvent: (e) => events.push(e),
    tokenBudgetChars: 20000,
  });

  await engine.send('搜索一下 syncthing 冲突文件的处理方案，给我一个对比');
  console.log('turn 1 done');
  await engine.send('如果我经常用手机和电脑同时编辑同一个 markdown 文件，怎么减少冲突？');
  console.log('turn 2 done');

  const md = vaultIO._files.get(engine.sessionPath);
  const sampleName = `smoke-${new Date().toISOString().slice(0, 10)}.md`;
  const samplePath = `samples/${sampleName}`;
  await fs.mkdir('samples', { recursive: true });
  await fs.writeFile(samplePath, md, 'utf8');
  console.log(`sample written to ${samplePath}`);
  console.log('events:', events.map(e => e.type));

  proc.kill();
  process.exit(0);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
