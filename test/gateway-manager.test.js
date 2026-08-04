import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { GatewayManager } from '../src/gateway-manager.js';
import { EventEmitter } from 'node:events';

function startMockServer(handler) {
  return new Promise((resolve) => {
    const server = http.createServer(handler);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({ server, url: `http://127.0.0.1:${port}` });
    });
  });
}

function makeFakeProcess() {
  const proc = new EventEmitter();
  proc.kill = () => {
    proc.killed = true;
    proc.emit('exit', 0);
  };
  proc.killed = false;
  return proc;
}

describe('GatewayManager', () => {
  it('probe returns true when /health is 200', async () => {
    const { server, url } = await startMockServer((req, res) => {
      if (req.url === '/health') {
        res.writeHead(200);
        res.end('ok');
      } else {
        res.writeHead(404);
        res.end();
      }
    });
    try {
      const gm = new GatewayManager({ gatewayUrl: url, installDir: '/tmp' });
      const ok = await gm.probe();
      assert.equal(ok, true);
      assert.equal(gm.status, 'ready');
    } finally {
      server.close();
    }
  });

  it('probe returns false when unreachable', async () => {
    const gm = new GatewayManager({ gatewayUrl: 'http://127.0.0.1:1', installDir: '/tmp' });
    const ok = await gm.probe(100);
    assert.equal(ok, false);
  });

  it('ensureReady returns error when autoStart is off and gateway unreachable', async () => {
    const gm = new GatewayManager({ gatewayUrl: 'http://127.0.0.1:1', installDir: '/tmp', autoStart: false });
    const result = await gm.ensureReady();
    assert.equal(result.ok, false);
    assert.ok(result.error.includes('自动拉起已关闭'));
    assert.equal(gm.status, 'unreachable');
  });

  it('ensureReady spawns real binary and waits for ready', async () => {
    const installDir = 'C:/Users/22414/dev/deepseek-device-skill';
    const port = 19876;
    const url = `http://127.0.0.1:${port}`;
    const gm = new GatewayManager({ gatewayUrl: url, installDir, port });
    try {
      const result = await gm.ensureReady();
      assert.equal(result.ok, true);
      assert.equal(result.started, true);
      assert.equal(gm.status, 'ready');
    } finally {
      gm.stop();
    }
  });

  it('ensureReady fails with friendly error if binary missing', async () => {
    const gm = new GatewayManager({
      gatewayUrl: 'http://127.0.0.1:19999',
      installDir: '/nonexistent-dir',
    });
    const result = await gm.ensureReady();
    assert.equal(result.ok, false);
    assert.ok(result.error.includes('未找到二进制'));
  });

  it('statusText reflects current status', () => {
    const gm = new GatewayManager({ gatewayUrl: 'http://127.0.0.1:18791', installDir: '/tmp' });
    gm.status = 'ready';
    assert.ok(gm.statusText().includes('绿'));
    gm.status = 'starting';
    assert.ok(gm.statusText().includes('黄'));
    gm.status = 'unreachable';
    assert.ok(gm.statusText().includes('红'));
  });
});
