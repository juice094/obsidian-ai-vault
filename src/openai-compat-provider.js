// OpenAI 兼容 fetch + SSE provider
// 行为与 engine.js 原硬编码实现逐事件等价。

export class OpenAICompatProvider {
  constructor({ gatewayUrl }) {
    this.gatewayUrl = gatewayUrl.replace(/\/$/, '');
  }

  async *streamChat({ messages, model, thinking, search, signal }) {
    const payload = {
      model,
      messages,
      stream: true,
    };

    const response = await fetch(`${this.gatewayUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal,
    });

    if (!response.ok) {
      throw new Error(`gateway error ${response.status}: ${await response.text()}`);
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buf = '';

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        const lines = buf.split('\n');
        buf = lines.pop();
        for (const line of lines) {
          const result = this._processSseLine(line);
          if (result) yield result;
        }
      }
    } finally {
      reader.releaseLock();
    }
  }

  _processSseLine(line) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('data:')) return null;
    const data = trimmed.slice(5).trim();
    if (data === '[DONE]') return null;
    try {
      const chunk = JSON.parse(data);
      const delta = chunk.choices?.[0]?.delta;
      if (!delta) {
        if (chunk.choices?.[0]?.finish_reason) {
          return { type: 'finish', usage: chunk.usage };
        }
        return null;
      }
      if (delta.content) return { type: 'content', delta: delta.content };
      if (delta.reasoning_content) return { type: 'reasoning', delta: delta.reasoning_content };
      if (delta.search_results) return { type: 'search_results', results: delta.search_results };
      if (chunk.choices?.[0]?.finish_reason) {
        return { type: 'finish', usage: chunk.usage };
      }
      return null;
    } catch {
      return null;
    }
  }
}
