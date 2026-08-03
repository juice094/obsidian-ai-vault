export interface OpenAICompatProviderOptions {
  gatewayUrl: string;
  apiKey?: string;
}

export interface StreamChatOptions {
  messages: { role: string; content: string }[];
  model: string;
  thinking: boolean;
  search: boolean;
  signal: AbortSignal;
}

export interface ProviderEvent {
  type: 'content' | 'reasoning' | 'search_results' | 'finish';
  delta?: string;
  results?: any;
  usage?: any;
}

export class OpenAICompatProvider {
  constructor(options: OpenAICompatProviderOptions);
  streamChat(options: StreamChatOptions): AsyncIterableIterator<ProviderEvent>;
}
