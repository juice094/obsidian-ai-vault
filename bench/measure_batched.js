import { createServer } from 'node:http';
import { SessionEngine } from '../src/engine.js';

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

function startMockServer(lines) {
  return new Promise((resolve) => {
    const server = createServer((req, res) => {
      let body = '';
      req.on('data', c => body += c);
      req.on('end', () => {
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        res.end(lines.join(''));
      });
    });
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({ server, url: `http://127.0.0.1:${port}` });
    });
  });
}

async function runStreamingBenchmark(deltaCount) {
  const lines = [
    'data: {"id":"cmpl-1","object":"chat.completion.chunk","created":1,"model":"deepseek-chat","choices":[{"index":0,"delta":{"role":"assistant"}}]}\n\n',
  ];
  const deltaText = '答案'.repeat(10); // 20 CJK chars per delta
  for (let i = 0; i < deltaCount; i++) {
    lines.push(`data: {"id":"cmpl-1","object":"chat.completion.chunk","created":1,"model":"deepseek-chat","choices":[{"index":0,"delta":{"content":"${deltaText}"}}]}\n\n`);
  }
  lines.push('data: {"id":"cmpl-1","object":"chat.completion.chunk","created":1,"model":"deepseek-chat","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\n');
  lines.push('data: [DONE]\n\n');

  const vaultIO = makeVaultIO();
  let writeCount = 0;
  let totalWrittenBytes = 0;
  const originalWrite = vaultIO.write;
  vaultIO.write = async (path, text) => {
    writeCount++;
    totalWrittenBytes += Buffer.byteLength(text, 'utf8');
    return originalWrite(path, text);
  };

  const { server, url } = await startMockServer(lines);
  try {
    const engine = new SessionEngine({
      gatewayUrl: url,
      model: 'deepseek-chat',
      thinking: false,
      search: false,
      vaultIO,
    });
    await engine.send('流式写入批处理测试');

    const contentChars = deltaText.length * deltaCount;
    const contentBytes = Buffer.byteLength(deltaText, 'utf8') * deltaCount;
    const amplification = totalWrittenBytes / contentBytes;

    console.log('==> Streaming write (batched)');
    console.log(`  deltas: ${deltaCount}`);
    console.log(`  content chars: ${contentChars}`);
    console.log(`  content bytes: ${contentBytes}`);
    console.log(`  write calls: ${writeCount}`);
    console.log(`  total written bytes: ${totalWrittenBytes}`);
    console.log(`  amplification: ${amplification.toFixed(2)}x`);
    return { deltaCount, contentChars, contentBytes, writeCount, totalWrittenBytes, amplification };
  } finally {
    server.close();
  }
}

const result = await runStreamingBenchmark(100);
console.log(`\nResult: ${result.writeCount} writes, ${result.amplification.toFixed(2)}x amplification`);
