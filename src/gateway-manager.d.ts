export interface GatewayManagerOptions {
  gatewayUrl?: string;
  installDir: string;
  port?: number;
  autoStart?: boolean;
  spawnFn?: (command: string, args: string[], options: unknown) => import('node:child_process').ChildProcess;
}

export interface EnsureReadyResult {
  ok: boolean;
  started?: boolean;
  error?: string;
}

export class GatewayManager {
  status: 'unknown' | 'ready' | 'starting' | 'unreachable' | 'error';
  statusMessage: string;
  constructor(options: GatewayManagerOptions);
  probe(timeoutMs?: number): Promise<boolean>;
  ensureReady(): Promise<EnsureReadyResult>;
  stop(): void;
  statusText(): string;
}
