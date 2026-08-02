export interface VaultIO {
  read(path: string): Promise<string>;
  write(path: string, text: string): Promise<void>;
  append(path: string, text: string): Promise<void>;
  exists(path: string): Promise<boolean>;
  rename(oldPath: string, newPath: string): Promise<void>;
  mkdir(path: string): Promise<void>;
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

export interface StreamChatOptions {
  messages: { role: string; content: string }[];
  model: string;
  thinking: boolean;
  search: boolean;
  signal?: AbortSignal;
}

export interface ProviderEvent {
  type: 'content' | 'reasoning' | 'search_results' | 'finish';
  delta?: string;
  results?: unknown;
  usage?: { total_tokens?: number };
}

export interface ProviderLike {
  streamChat(options: StreamChatOptions): AsyncIterable<ProviderEvent>;
}

export interface SessionEngineOptions {
  gatewayUrl?: string;
  model: string;
  thinking: boolean;
  search: boolean;
  vaultIO: VaultIO;
  onEvent?: (event: EngineEvent) => void;
  tokenBudgetChars?: number;
  /** 选择 provider：'openai-compat'（默认）、'openclaw'，或直接传入 provider 实例。 */
  provider?: 'openai-compat' | 'openclaw' | ProviderLike;
  /** OpenClaw 完整 WebSocket URL（含路径）。 */
  openclawUrl?: string;
  /** OpenClaw admin token。 */
  openclawToken?: string;
}

export class SessionEngine {
  sessionPath: string | null;
  constructor(options: SessionEngineOptions);
  send(userText: string): Promise<{ path: string }>;
  resume(): Promise<void>;
}
