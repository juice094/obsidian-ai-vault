export interface VaultIO {
  read(path: string): Promise<string>;
  write(path: string, text: string): Promise<void>;
  append(path: string, text: string): Promise<void>;
  exists(path: string): Promise<boolean>;
  rename(oldPath: string, newPath: string): Promise<void>;
}

export interface EngineEvent {
  type: string;
  path?: string;
  turnId?: number;
  delta?: string;
  results?: unknown[];
  coversTurn?: number;
  error?: string;
}

export interface SessionEngineOptions {
  gatewayUrl: string;
  model: string;
  thinking: boolean;
  search: boolean;
  vaultIO: VaultIO;
  onEvent?: (event: EngineEvent) => void;
  tokenBudgetChars?: number;
}

export class SessionEngine {
  sessionPath: string | null;
  constructor(options: SessionEngineOptions);
  send(userText: string): Promise<{ path: string }>;
  resume(): Promise<void>;
}
