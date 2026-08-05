// SyncBridge 生命周期管理器（桌面插件属主）
// ponytail: 直接复制 GatewayManager 模式并做最小改动；通用抽象成本高于收益，故保持独立。
// 依赖约定：watch 子进程在运行期间持有 <state>.lock 文件（JSON：{ pid, ts }），
//          manager 通过锁文件新鲜度判断健康；自己拉起的进程在 unload 时 kill。

import { spawn as defaultSpawn } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync, unlinkSync } from 'node:fs';
import { join, resolve } from 'node:path';

export class SyncBridgeManager {
  constructor({
    vaultPath,
    syncDirPath,
    password,
    saltFile,
    stateFile,
    trashPath,
    installDir,
    autoStart = true,
    spawnFn = defaultSpawn,
  }) {
    this.vaultPath = vaultPath || '';
    this.syncDirPath = syncDirPath || '';
    this.password = password || '';
    this.saltFile = saltFile || '';
    this.stateFile = stateFile || '';
    this.trashPath = trashPath || '';
    this.installDir = installDir || '';
    this.autoStart = autoStart;
    this.spawnFn = spawnFn;
    this.process = null;
    this.status = 'unknown';
    this.statusMessage = '';
    this.logTail = '';
    this.lockFile = this.stateFile ? `${this.stateFile}.lock` : '';
  }

  /** 探测 watch 进程是否存活（锁文件新鲜且 PID 存在） */
  async probe() {
    if (!this.lockFile || !existsSync(this.lockFile)) {
      return false;
    }
    try {
      const raw = readFileSync(this.lockFile, 'utf8');
      const lock = JSON.parse(raw);
      const ageMs = Date.now() - (lock.ts || 0);
      if (ageMs > 10000) {
        return false;
      }
      if (lock.pid && !this._pidExists(lock.pid)) {
        return false;
      }
      this.status = 'ready';
      this.statusMessage = 'watch 进程就绪';
      return true;
    } catch {
      return false;
    }
  }

  /** 确保 watch 就绪；必要时自动拉起 */
  async ensureReady() {
    if (await this.probe()) {
      return { ok: true, started: false };
    }
    if (!this.autoStart) {
      this.status = 'unreachable';
      return {
        ok: false,
        error: '同步桥 watch 未运行，且自动拉起已关闭。',
      };
    }
    return this._startAndWait();
  }

  async _startAndWait() {
    this.status = 'starting';
    const spawned = await this._spawnWatch();
    if (!spawned) {
      this.status = 'error';
      return {
        ok: false,
        error: `自动拉起同步桥失败：${this.statusMessage}。请检查 crypto-adapter 安装目录、确认已执行 cargo build --release。`,
      };
    }
    const ready = await this._pollReady(8000, 300);
    if (!ready) {
      this._kill();
      this.status = 'error';
      return {
        ok: false,
        error: '同步桥 watch 启动超时（8s）。请检查 vault/sync 路径、state 与 trash 是否可写。',
      };
    }
    this.status = 'ready';
    return { ok: true, started: true };
  }

  _spawnWatch() {
    return new Promise((resolve) => {
      const binary = this._binaryPath();
      if (!existsSync(binary)) {
        this.statusMessage = `未找到二进制：${binary}`;
        resolve(false);
        return;
      }
      if (!this.vaultPath || !this.syncDirPath || !this.saltFile || !this.stateFile || !this.trashPath) {
        this.statusMessage = '缺少 vault/sync/salt/state/trash 路径之一';
        resolve(false);
        return;
      }
      const args = [
        'watch',
        '--vault', resolve(this.vaultPath),
        '--sync', resolve(this.syncDirPath),
        '--password', this.password,
        '--salt-file', resolve(this.saltFile),
        '--state', resolve(this.stateFile),
        '--sync-trash', resolve(this.trashPath),
      ];
      let settled = false;
      try {
        this.process = this.spawnFn(binary, args, {
          cwd: this.installDir,
          stdio: ['ignore', 'ignore', 'pipe'],
          detached: false,
        });
      } catch (err) {
        this.statusMessage = err.message;
        resolve(false);
        return;
      }

      this.process.stderr?.on('data', (chunk) => {
        const line = chunk.toString().trim();
        if (line) this.logTail = line;
      });

      this.process.on('error', (err) => {
        if (!settled) {
          settled = true;
          this.statusMessage = err.message;
          resolve(false);
        }
      });

      this.process.on('spawn', () => {
        if (!settled) {
          settled = true;
          resolve(true);
        }
      });

      this.process.on('exit', (code) => {
        if (!settled) {
          settled = true;
          this.statusMessage = `进程退出，码 ${code ?? 'unknown'}`;
          resolve(false);
        } else if (this.status === 'starting' || this.status === 'ready') {
          this.status = 'error';
          this.statusMessage = `watch 异常退出，码 ${code ?? 'unknown'}`;
        }
      });
    });
  }

  _binaryPath() {
    // Cargo 在 Windows 上把 crate 名的连字符换成下划线生成二进制名
    const base = `${this.installDir}/target/release/obsidian_vault_crypto_adapter`;
    return process.platform === 'win32' ? `${base}.exe` : base;
  }

  async _pollReady(totalMs, intervalMs) {
    const start = Date.now();
    while (Date.now() - start < totalMs) {
      if (await this.probe(intervalMs)) return true;
      await new Promise((r) => setTimeout(r, intervalMs));
    }
    return false;
  }

  /** 停止本管理器拉起的 watch 进程 */
  stop() {
    this._kill();
    this._clearLock();
  }

  _kill() {
    if (this.process) {
      try {
        this.process.kill();
      } catch {
        // ignore
      }
      this.process = null;
    }
  }

  _clearLock() {
    if (this.lockFile && existsSync(this.lockFile)) {
      try {
        unlinkSync(this.lockFile);
      } catch {
        // ignore
      }
    }
  }

  _pidExists(pid) {
    try {
      // Node 没有跨平台非致命进程存在性检测；kill(0) 在 Windows 会报错，故用 signal 0 仅 POSIX。
      process.kill(Number(pid), 0);
      return true;
    } catch {
      return false;
    }
  }

  /** 人类可读的状态文本 */
  statusText() {
    const map = {
      ready: '绿：同步桥运行中',
      starting: '黄：正在拉起同步桥',
      unreachable: '红：同步桥未运行',
      error: `红：${this.statusMessage || '同步桥异常'}`,
      unknown: '灰：未探测',
    };
    return map[this.status] || `灰：${this.status}`;
  }
}
