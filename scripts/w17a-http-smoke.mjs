// W17a: HTTP 面 OpenClaw gateway 冒烟（只读不改码）。
// 验证：真实 agent 回复、stream SSE 可用、reasoning/search 扩展字段。
// 凭证从 claw-cred.txt 读取，不进提交。

import { readFileSync, writeFileSync } from 'node:fs';
import { setTimeout } from 'node:timers/promises';

const credPath = new URL('../claw-cred.txt', import.meta.url);
const lines = readFileSync(credPath, 'utf8').split(/\r?\n/);
let endpoint = 'http://100.69.11.71:18789';
let token = '';
for (const line of lines) {
  if (line.startsWith('endpoint:')) {
    const v = line.slice('endpoint:'.length).trim();
    if (v.startsWith('http')) endpoint = v.replace(/\/ws$/, '').replace(/:18789.*$/, ':18789');
  }
  if (line.startsWith('token:')) token = line.slice('token:'.length).trim();
}

const argEndpoint = process.argv.find(a => a.startsWith('http://') || a.startsWith('https://'));
if (argEndpoint) endpoint = argEndpoint;
const url = `${endpoint.replace(/\/$/, '')}/v1/chat/completions`;

if (!token) {
  console.error('无法从 claw-cred.txt 解析 token');
  process.exit(1);
}

console.log('endpoint:', endpoint);
console.log('url:', url);
console.log('token length:', token.length);

const body = {
  model: 'deepseek-chat',
  messages: [{ role: 'user', content: '用一句话问候我，并说明你是否支持 reasoning/search 扩展。' }],
  stream: true,
  // 尝试请求扩展能力；HTTP 面若不支持会忽略未知字段
  reasoning: true,
  search: true,
};

async function run() {
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${token}`,
    },
    body: JSON.stringify(body),
  });

  console.log('\nstatus:', res.status);
  console.log('content-type:', res.headers.get('content-type'));

  if (!res.ok) {
    const text = await res.text();
    console.error('HTTP error body:', text.slice(0, 500));
    process.exit(1);
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let fullText = '';
  let fullReasoning = '';
  let hasSearch = false;
  let chunkCount = 0;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    const text = decoder.decode(value, { stream: true });
    for (const line of text.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed || trimmed === 'data: [DONE]') continue;
      if (!trimmed.startsWith('data:')) continue;
      const payload = trimmed.slice(5).trim();
      try {
        const data = JSON.parse(payload);
        chunkCount++;
        const delta = data.choices?.[0]?.delta;
        if (delta?.content) fullText += delta.content;
        if (delta?.reasoning_content) fullReasoning += delta.reasoning_content;
        if (delta?.search_results || data.search_results) hasSearch = true;
      } catch (err) {
        // ignore malformed SSE lines
      }
    }
  }

  console.log('\n--- result ---');
  console.log('SSE chunks:', chunkCount);
  console.log('has text:', fullText.length > 0);
  console.log('text preview:', fullText.slice(0, 200));
  console.log('has reasoning:', fullReasoning.length > 0);
  console.log('reasoning preview:', fullReasoning.slice(0, 200));
  console.log('has search:', hasSearch);

  const report = {
    endpoint,
    url,
    status: res.status,
    contentType: res.headers.get('content-type'),
    chunkCount,
    textLength: fullText.length,
    reasoningLength: fullReasoning.length,
    hasSearch,
    textPreview: fullText.slice(0, 400),
    reasoningPreview: fullReasoning.slice(0, 400),
    testedAt: new Date().toISOString(),
  };
  writeFileSync(new URL('../docs/w17a-http-smoke-report.json', import.meta.url), JSON.stringify(report, null, 2), 'utf8');
  console.log('\nreport saved to docs/w17a-http-smoke-report.json');

  const ok = fullText.length > 0 && chunkCount > 0;
  process.exit(ok ? 0 : 1);
}

run().catch(err => {
  console.error('smoke failed:', err.message || String(err));
  process.exit(1);
});
