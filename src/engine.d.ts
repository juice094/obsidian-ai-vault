export interface VaultIO {
  read(path: string): Promise<string>;
  write(path: string, text: string): Promise<void>;
  append(path: string, text: string): Promise<void>;
  exists(path: string): Promise<boolean>;
  rename(oldPath: string, newPath: string): Promise<void>;
  mkdir(path: string): Promise<void>;
  /** 返回库内所有 .md 文件的相对路径。 */
  list(): Promise<string[]>;
}

export interface EngineEvent {
  type: string;
  path?: string;
  turnId?: number;
  delta?: string;
  results?: unknown[];
  coversTurn?: number;
  error?: string;
  names?: string[];
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
  /** OpenClaw client id（默认 gateway-client）。 */
  clientId?: string;
  /** 路由标记：'local' = 本地/内嵌 DeepSeek gateway；'openclaw' = 远程 OpenClaw agent。写入 turn meta。 */
  route?: 'local' | 'openclaw';
  /** 覆盖默认 session key；openclaw 路由默认 obsidian-{sessionId}。 */
  sessionKey?: string;
  /** 对侧 agent 标识，用于 x-openclaw-agent-id header。 */
  agentId?: string;
  /** 对侧代理身份：main = 格雷；device = device。仅影响显示与 turn meta。 */
  peerAgent?: 'main' | 'device';
  /** 会话入口：note = 每个 md 隔离；main = 挂接格雷主会话（key = agent:main:main）。 */
  sessionEntry?: 'note' | 'main';
}

export class SessionEngine {
  sessionPath: string | null;
  constructor(options: SessionEngineOptions);
  send(userText: string): Promise<{ path: string }>;
  resume(): Promise<void>;
}
