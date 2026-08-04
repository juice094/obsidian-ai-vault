// 本地 gateway 生命周期管理器（桌面插件属主）
// ponytail: 只负责自己拉起的进程；外部已运行的 gateway 不归我们 kill。

import { spawn as defaultSpawn } from 'node:child_process';
import { existsSync } from 'node:fs';

export class GatewayManager {
  constructor({ gatewayUrl, installDir, port, autoStart = true, spawnFn = defaultSpawn }) {
    this.gatewayUrl = (gatewayUrl || `http://127.0.0.1:${port}`).replace(/\/$/, '');
    this.installDir = installDir || '';
    this.port = port || 18791;
    this.autoStart = autoStart;
    this.spawnFn = spawnFn;
    this.process = null;
    this.status = 'unknown';
    this.statusMessage = '';
  }

  /** 探测 /health，返回是否就绪 */
  async probe(timeoutMs = 1500) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(`${this.gatewayUrl}/health`, { signal: controller.signal });
      if (res.ok) {
        this.status = 'ready';
        this.statusMessage = 'gateway 就绪';
        return true;
      }
    } catch {
      // ignore: unreachable
    } finally {
      clearTimeout(timer);
    }
    return false;
  }

  /** 确保 gateway 就绪；必要时自动拉起 */
  async ensureReady() {
    if (await this.probe()) {
      return { ok: true, started: false };
    }
    if (!this.autoStart) {
      this.status = 'unreachable';
      return {
        ok: false,
        error: '本地 gateway 未运行，且自动拉起已关闭。请在设置页检查安装目录，或切换 OpenClaw 远程路由。',
      };
    }
    return this._startAndWait();
  }

  async _startAndWait() {
    this.status = 'starting';
    const spawned = await this._spawnGateway();
    if (!spawned) {
      this.status = 'error';
      return {
        ok: false,
        error: `自动拉起本地 gateway 失败：${this.statusMessage}。请检查设置页安装目录、确认已执行 cargo build --release。`,
      };
    }
    const ready = await this._pollReady(8000, 300);
    if (!ready) {
      this._kill();
      this.status = 'error';
      return {
        ok: false,
        error: '本地 gateway 启动超时（8s）。请检查端口占用、凭证文件 dds-cred.txt 是否存在，或手动运行 gateway 看日志。',
      };
    }
    this.status = 'ready';
    return { ok: true, started: true };
  }

  _spawnGateway() {
    return new Promise((resolve) => {
      const binary = this._binaryPath();
      if (!existsSync(binary)) {
        this.statusMessage = `未找到二进制：${binary}`;
        resolve(false);
        return;
      }
      const args = ['serve', '--host', '127.0.0.1', '--port', String(this.port)];
      let settled = false;
      try {
        this.process = this.spawnFn(binary, args, {
          cwd: this.installDir,
          stdio: 'ignore',
          detached: false,
        });
      } catch (err) {
        this.statusMessage = err.message;
        resolve(false);
        return;
      }

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
          this.statusMessage = `gateway 异常退出，码 ${code ?? 'unknown'}`;
        }
      });
    });
  }

  _binaryPath() {
    const base = `${this.installDir}/target/release/deepseek-device-skill`;
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

  /** 停止本管理器拉起的 gateway 进程 */
  stop() {
    this._kill();
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

  /** 人类可读的状态文本 */
  statusText() {
    const map = {
      ready: '绿：gateway 就绪',
      starting: '黄：正在拉起 gateway',
      unreachable: '红：gateway 不可达',
      error: `红：${this.statusMessage || 'gateway 异常'}`,
      unknown: '灰：未探测',
    };
    return map[this.status] || `灰：${this.status}`;
  }
}
