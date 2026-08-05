export interface SyncBridgeManagerOptions {
  vaultPath?: string;
  syncDirPath?: string;
  password?: string;
  saltFile?: string;
  stateFile?: string;
  trashPath?: string;
  installDir: string;
  autoStart?: boolean;
  spawnFn?: (command: string, args: string[], options: unknown) => import('node:child_process').ChildProcess;
}

export interface EnsureReadyResult {
  ok: boolean;
  started?: boolean;
  error?: string;
}

export class SyncBridgeManager {
  status: 'unknown' | 'ready' | 'starting' | 'unreachable' | 'error';
  statusMessage: string;
  logTail: string;
  constructor(options: SyncBridgeManagerOptions);
  probe(): Promise<boolean>;
  ensureReady(): Promise<EnsureReadyResult>;
  stop(): void;
  statusText(): string;
}
