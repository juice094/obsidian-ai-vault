import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { SyncBridgeManager } from '../src/sync-bridge-manager.js';
import { EventEmitter } from 'node:events';
import { existsSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

function makeFakeProcess() {
  const proc = new EventEmitter();
  proc.stderr = new EventEmitter();
  proc.kill = () => {
    proc.killed = true;
    proc.emit('exit', 0);
  };
  proc.killed = false;
  return proc;
}

function makeTmpDir() {
  const dir = join(tmpdir(), `sbm-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

describe('SyncBridgeManager', () => {
  it('probe returns false when lock file missing', async () => {
    const sbm = new SyncBridgeManager({ installDir: '/tmp' });
    const ok = await sbm.probe();
    assert.equal(ok, false);
  });

  it('probe returns true when lock file is fresh', async () => {
    const tmp = makeTmpDir();
    const stateFile = join(tmp, 'state.json');
    writeFileSync(`${stateFile}.lock`, JSON.stringify({ pid: process.pid, ts: Date.now() }));
    const sbm = new SyncBridgeManager({ installDir: '/tmp', stateFile });
    const ok = await sbm.probe();
    assert.equal(ok, true);
    assert.equal(sbm.status, 'ready');
    rmSync(tmp, { recursive: true, force: true });
  });

  it('ensureReady returns error when autoStart is off and unreachable', async () => {
    const sbm = new SyncBridgeManager({ installDir: '/tmp', autoStart: false });
    const result = await sbm.ensureReady();
    assert.equal(result.ok, false);
    assert.ok(result.error.includes('自动拉起已关闭'));
    assert.equal(sbm.status, 'unreachable');
  });

  it('ensureReady fails with friendly error if binary missing', async () => {
    const sbm = new SyncBridgeManager({
      installDir: '/nonexistent-dir',
      vaultPath: '/tmp/v',
      syncDirPath: '/tmp/s',
      password: 'p',
      saltFile: '/tmp/salt',
      stateFile: '/tmp/state',
      trashPath: '/tmp/trash',
    });
    const result = await sbm.ensureReady();
    assert.equal(result.ok, false);
    assert.ok(result.error.includes('未找到二进制'));
  });

  it('captures stderr as log tail', async () => {
    const sbm = new SyncBridgeManager({ installDir: '/tmp' });
    const proc = makeFakeProcess();
    let spawned = false;
    sbm.spawnFn = () => {
      spawned = true;
      return proc;
    };
    sbm._binaryPath = () => process.execPath;
    sbm.vaultPath = '/tmp/v';
    sbm.syncDirPath = '/tmp/s';
    sbm.password = 'p';
    sbm.saltFile = '/tmp/salt';
    sbm.stateFile = '/tmp/state';
    sbm.trashPath = '/tmp/trash';
    sbm.lockFile = '/tmp/state.json.lock';

    // 立即让 probe 成功，避免等待真实子进程
    const ensurePromise = sbm.ensureReady();
    setTimeout(() => {
      proc.stderr.emit('data', Buffer.from('sync up complete: added=1'));
      writeFileSync(sbm.lockFile, JSON.stringify({ pid: process.pid, ts: Date.now() }));
      proc.emit('spawn');
    }, 50);

    const result = await ensurePromise;
    assert.equal(spawned, true);
    assert.equal(result.ok, true);
    assert.equal(sbm.logTail, 'sync up complete: added=1');

    sbm.stop();
    if (existsSync(sbm.lockFile)) rmSync(sbm.lockFile);
  });

  it('statusText reflects current status', () => {
    const sbm = new SyncBridgeManager({ installDir: '/tmp' });
    sbm.status = 'ready';
    assert.ok(sbm.statusText().includes('绿'));
    sbm.status = 'starting';
    assert.ok(sbm.statusText().includes('黄'));
    sbm.status = 'unreachable';
    assert.ok(sbm.statusText().includes('红'));
  });
});
