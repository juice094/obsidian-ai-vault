import { readFileSync, writeFileSync, unlinkSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseSession, appendTurn, buildMessages, serializeTurn } from '../src/format.js';
import { generateFixture } from './fixtures.js';

const ROUNDS_LIST = [50, 200, 500];
const REPEATS = 30;

function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 0) {
    return (sorted[mid - 1] + sorted[mid]) / 2;
  }
  return sorted[mid];
}

function nowMs() {
  return Number(process.hrtime.bigint()) / 1e6;
}

function measure(name, fn, repeats = REPEATS) {
  const times = [];
  for (let i = 0; i < repeats; i++) {
    const start = nowMs();
    fn();
    const end = nowMs();
    times.push(end - start);
  }
  const med = median(times);
  const min = Math.min(...times);
  const max = Math.max(...times);
  console.log(`${name}: median=${med.toFixed(3)}ms min=${min.toFixed(3)}ms max=${max.toFixed(3)}ms`);
  return med;
}

function writeTmp(content) {
  const dir = mkdtempSync(join(tmpdir(), 'ai-vault-bench-'));
  const path = join(dir, 'session.md');
  writeFileSync(path, content, 'utf8');
  return { path, dir };
}

function buildExtraTurn(id) {
  return {
    id,
    userText: `额外的问题 ${id}，用于测试追加写入的性能表现。`,
    thinks: [{ elapsedSecs: 5, text: '思考中…' }],
    searches: [{
      queries: ['benchmark'],
      results: [
        { index: 1, title: 'Benchmark A', url: 'https://example.com/a', site: 'example.com' },
        { index: 2, title: 'Benchmark B', url: 'https://example.com/b', site: 'example.com' },
      ],
    }],
    bodyBlocks: ['追加的正文段落，用于模拟一次新的 assistant 回复。'],
    meta: { user_msg: '20', ai_msg: String(id), model: 'expert', tokens: '100', time: new Date().toISOString() },
    inProgress: false,
    aiBeginId: id,
  };
}

console.log('==> Environment');
console.log(`Node: ${process.version}`);
console.log(`Platform: ${process.platform} ${process.arch}`);
console.log(`CPU: ${process.env.PROCESSOR_IDENTIFIER || 'unknown'}`);
console.log('');

const results = [];

for (const rounds of ROUNDS_LIST) {
  console.log(`==> Fixture: ${rounds} rounds`);
  const md = generateFixture(rounds);
  const sizeBytes = Buffer.byteLength(md, 'utf8');
  console.log(`size: ${sizeBytes} bytes (${(sizeBytes / 1024).toFixed(1)} KB)`);

  const tmp = writeTmp(md);
  const parsedOnce = parseSession(md);

  const parseMs = measure(`  parseSession(${rounds})`, () => {
    parseSession(readFileSync(tmp.path, 'utf8'));
  });

  const buildMs = measure(`  buildMessages(${rounds})`, () => {
    buildMessages(parsedOnce, { tokenBudgetChars: 12000 });
  });

  const extraTurn = buildExtraTurn(rounds + 1);
  const appendMs = measure(`  appendTurn+write(${rounds})`, () => {
    const updated = appendTurn(md, extraTurn);
    writeFileSync(tmp.path, updated, 'utf8');
  });

  results.push({ rounds, sizeBytes, parseMs, buildMs, appendMs });

  unlinkSync(tmp.path);
}

console.log('\n==> Streaming write amplification (baseline, unbatched)');
{
  const deltaCount = 100;
  const deltaText = '答案'.repeat(10); // 20 CJK chars per delta, 2000 chars total
  const totalContentChars = deltaText.length * deltaCount;
  const totalContentBytes = Buffer.byteLength(deltaText, 'utf8') * deltaCount;

  // Simulate current engine behavior: every delta rewrites prefix + current turn.
  const baseMd = generateFixture(1); // a single completed turn as prefix
  const parsed = parseSession(baseMd);
  const turnId = parsed.turns.length + 1;
  const userTurn = {
    id: turnId,
    userText: '流式写入性能测试',
    thinks: [],
    searches: [],
    bodyBlocks: [],
    meta: {},
    inProgress: true,
    aiBeginId: turnId,
  };
  let md = appendTurn(baseMd, userTurn);

  const marker = `<!-- turn:${turnId}`;
  const markerIdx = md.indexOf(marker);
  const prefix = md.slice(0, markerIdx);

  let writeCount = 0;
  let totalWrittenBytes = 0;
  let bodyText = '';
  let thinkText = '';
  const turnState = { ...userTurn, thinks: [], searches: [], bodyBlocks: [], aiBeginId: turnId };

  for (let i = 0; i < deltaCount; i++) {
    bodyText += deltaText;
    turnState.bodyBlocks = bodyText ? bodyText.split(/\n\n+/).map(s => s.trim()).filter(Boolean) : [];
    thinkText += '思考中…';
    turnState.thinks = [{ elapsedSecs: null, text: thinkText }];

    const out = prefix + serializeTurn(turnState);
    writeCount++;
    totalWrittenBytes += Buffer.byteLength(out, 'utf8');
  }

  const amplification = totalWrittenBytes / totalContentBytes;
  console.log(`  deltas: ${deltaCount}`);
  console.log(`  content chars: ${totalContentChars}`);
  console.log(`  content bytes: ${totalContentBytes}`);
  console.log(`  write calls: ${writeCount}`);
  console.log(`  total written bytes: ${totalWrittenBytes}`);
  console.log(`  amplification: ${amplification.toFixed(2)}x`);
  results.push({ streaming: { deltaCount, contentChars: totalContentChars, contentBytes: totalContentBytes, writeCount, totalWrittenBytes, amplification } });
}

console.log('\n==> Summary');
console.log('| rounds | size (KB) | parse (ms) | build (ms) | append (ms) |');
console.log('| --- | --- | --- | --- | --- |');
for (const r of results.filter(x => x.rounds)) {
  console.log(`| ${r.rounds} | ${(r.sizeBytes / 1024).toFixed(1)} | ${r.parseMs.toFixed(3)} | ${r.buildMs.toFixed(3)} | ${r.appendMs.toFixed(3)} |`);
}

const streaming = results.find(x => x.streaming)?.streaming;
if (streaming) {
  console.log(`\nStreaming amplification: ${streaming.amplification.toFixed(2)}x (${streaming.writeCount} writes for ${streaming.deltaCount} deltas)`);
}

// go/no-go
const r200 = results.find(r => r.rounds === 200);
const parseBuild200 = r200.parseMs + r200.buildMs;
const r3Trigger = parseBuild200 > 100;
const r1Priority = streaming.amplification > 50;

console.log('\n==> Go/No-go');
console.log(`R3 trigger (200 rounds parse+build > 100ms): ${r3Trigger ? 'GO' : 'NO-GO'} (${parseBuild200.toFixed(3)}ms)`);
console.log(`R1 priority (amplification > 50x): ${r1Priority ? 'HIGHEST' : 'NORMAL'} (${streaming.amplification.toFixed(2)}x)`);
