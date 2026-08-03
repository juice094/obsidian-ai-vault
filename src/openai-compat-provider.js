// OpenAI 兼容 fetch + SSE provider
// 行为与 engine.js 原硬编码实现逐事件等价。

export class OpenAICompatProvider {
  constructor({ gatewayUrl, apiKey, headers }) {
    this.gatewayUrl = gatewayUrl.replace(/\/$/, '');
    this.apiKey = apiKey || '';
    this.extraHeaders = headers || {};
  }

  async *streamChat({ messages, model, thinking, search, signal }) {
    const payload = {
      model,
      messages,
      stream: true,
    };

    const headers = {
      'Content-Type': 'application/json',
      ...this.extraHeaders,
    };
    if (this.apiKey) headers['Authorization'] = `Bearer ${this.apiKey}`;

    const response = await fetch(`${this.gatewayUrl}/v1/chat/completions`, {
      method: 'POST',
      headers,
      body: JSON.stringify(payload),
      signal,
    });

    if (!response.ok) {
      throw new Error(`gateway error ${response.status}: ${await response.text()}`);
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buf = '';
    const toolBuffers = new Map();

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        const lines = buf.split('\n');
        buf = lines.pop();
        for (const line of lines) {
          const results = this._processSseLine(line, toolBuffers);
          if (results) {
            for (const result of (Array.isArray(results) ? results : [results])) {
              yield result;
            }
          }
        }
      }
    } finally {
      reader.releaseLock();
    }
  }

  _processSseLine(line, toolBuffers) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('data:')) return null;
    const data = trimmed.slice(5).trim();
    if (data === '[DONE]') return null;
    try {
      const chunk = JSON.parse(data);
      const choice = chunk.choices?.[0];
      const delta = choice?.delta;
      const finishReason = choice?.finish_reason;

      if (delta?.tool_calls) {
        for (const tc of delta.tool_calls) {
          const idx = tc.index ?? 0;
          const existing = toolBuffers.get(idx) || { id: '', type: '', name: '', args: '' };
          if (tc.id) existing.id = tc.id;
          if (tc.type) existing.type = tc.type;
          if (tc.function?.name) existing.name = tc.function.name;
          if (tc.function?.arguments) existing.args += tc.function.arguments;
          toolBuffers.set(idx, existing);
        }
      }

      if (finishReason === 'tool_calls') {
        const queries = [];
        for (const tc of toolBuffers.values()) {
          let args = {};
          try { args = JSON.parse(tc.args); } catch {}
          const query = args.query || args.q || args.search || tc.name;
          if (query) queries.push(query);
        }
        toolBuffers.clear();
        const events = [];
        if (queries.length > 0) {
          events.push({ type: 'search_results', results: { queries, results: [] } });
        }
        events.push({ type: 'finish', usage: chunk.usage });
        return events;
      }

      if (delta?.content) return { type: 'content', delta: delta.content };
      if (delta?.reasoning_content) return { type: 'reasoning', delta: delta.reasoning_content };
      if (delta?.search_results) return { type: 'search_results', results: delta.search_results };

      if (finishReason) {
        return { type: 'finish', usage: chunk.usage };
      }
      return null;
    } catch {
      return null;
    }
  }
}
