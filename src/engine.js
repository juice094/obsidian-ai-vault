import { parseSession, serializeTurn, appendTurn, writeSummary, buildMessages } from './format.js';
import { SUMMARY_PROMPT } from './prompts.js';

function todayDate() {
  return new Date().toISOString().slice(0, 10);
}

function nowIso() {
  return new Date().toISOString();
}

function titleFromUserText(text) {
  return text.slice(0, 20).replace(/\s+/g, ' ').trim();
}

function makeFrontmatter({ sessionId, model, thinking, search }) {
  const fm = {
    chat_format: '1',
    session_id: sessionId,
    model,
    thinking: String(thinking),
    search: String(search),
    created: nowIso(),
  };
  return Object.entries(fm).map(([k, v]) => `${k}: ${v}`).join('\n');
}

function makeMeta({ turnId, userTextLen, model, usage }) {
  return {
    user_msg: String(userTextLen),
    ai_msg: String(turnId),
    model,
    tokens: usage ? String(usage.total_tokens) : '',
    time: nowIso(),
  };
}

export class SessionEngine {
  constructor({ gatewayUrl, model, thinking, search, vaultIO, onEvent, tokenBudgetChars = 12000 }) {
    this.gatewayUrl = gatewayUrl.replace(/\/$/, '');
    this.model = model;
    this.thinking = thinking;
    this.search = search;
    this.vaultIO = vaultIO;
    this.onEvent = onEvent || (() => {});
    this.tokenBudgetChars = tokenBudgetChars;
    this.sessionPath = null;
    this.sessionId = crypto.randomUUID ? crypto.randomUUID() : `session-${Date.now()}`;
  }

  async send(userText) {
    try {
      await this._ensureSession(userText);
      const md = await this.vaultIO.read(this.sessionPath);
      const parsed = parseSession(md);

      const turnId = (parsed.turns.length || 0) + 1;
      const userTurn = {
        id: turnId,
        userText,
        thinks: [],
        searches: [],
        bodyBlocks: [],
        meta: {},
        inProgress: true,
        aiBeginId: null,
      };
      let updated = appendTurn(md, userTurn);
      await this.vaultIO.write(this.sessionPath, updated);
      this.onEvent({ type: 'user-saved', path: this.sessionPath });

      const messages = buildMessages(parseSession(updated), { tokenBudgetChars: this.tokenBudgetChars });
      const payload = {
        model: this.model,
        messages,
        stream: true,
      };

      const response = await fetch(`${this.gatewayUrl}/v1/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      if (!response.ok) {
        throw new Error(`gateway error ${response.status}: ${await response.text()}`);
      }

      const { md: completed } = await this._consumeStream(response, userTurn);
      await this.vaultIO.write(this.sessionPath, completed);

      // 压缩检查
      const afterParse = parseSession(completed);
      const checkMessages = buildMessages(afterParse, { tokenBudgetChars: this.tokenBudgetChars });
      const totalChars = checkMessages.reduce((s, m) => s + m.content.length, 0);
      if (totalChars > this.tokenBudgetChars && afterParse.turns.length > 1) {
        await this._compact(completed, afterParse);
      }

      this.onEvent({ type: 'turn-done', path: this.sessionPath, turnId });
      return { path: this.sessionPath };
    } catch (err) {
      this.onEvent({ type: 'error', error: err.message });
      throw err;
    }
  }

  async _consumeStream(response, turn) {
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buf = '';
    let baseMd = await this.vaultIO.read(this.sessionPath);

    // 当前 turn 之前的内容（不含当前 turn）
    const marker = `<!-- turn:${turn.id}`;
    const markerIdx = baseMd.indexOf(marker);
    if (markerIdx === -1) throw new Error('turn marker missing');
    const prefix = baseMd.slice(0, markerIdx);

    const turnState = {
      ...turn,
      thinks: [],
      searches: [],
      bodyBlocks: [],
      aiBeginId: turn.id,
    };
    let bodyText = '';
    let thinkText = '';
    let searchResults = null;
    let usage = null;

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      const lines = buf.split('\n');
      buf = lines.pop();
      for (const line of lines) {
        const result = this._processSseLine(line);
        if (!result) continue;
        if (result.type === 'content') {
          bodyText += result.delta;
          turnState.bodyBlocks = bodyText ? bodyText.split(/\n\n+/).map(s => s.trim()).filter(Boolean) : [];
          this.onEvent({ type: 'content-delta', delta: result.delta });
        } else if (result.type === 'reasoning') {
          thinkText += result.delta;
          turnState.thinks = thinkText ? [{ elapsedSecs: null, text: thinkText }] : [];
          this.onEvent({ type: 'think-delta', delta: result.delta });
        } else if (result.type === 'search_results') {
          searchResults = result.results;
          turnState.searches = [this._toSearchEntry(result.results)];
          this.onEvent({ type: 'search-done', results: result.results.results });
        } else if (result.type === 'finish') {
          usage = result.usage;
        }
        // 每次 delta 后重写整个当前 turn 区段（保持文件实时可解析）
        await this.vaultIO.write(this.sessionPath, prefix + serializeTurn(turnState));
      }
    }

    // 最终版：inProgress=false，带 meta
    const finalTurn = {
      ...turnState,
      meta: makeMeta({ turnId: turn.id, userTextLen: turn.userText.length, model: this.model, usage }),
      inProgress: false,
    };
    return { md: prefix + serializeTurn(finalTurn) };
  }

  _processSseLine(line) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('data:')) return null;
    const data = trimmed.slice(5).trim();
    if (data === '[DONE]') return { type: 'done' };
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

  _toSearchEntry(bundle) {
    const queries = bundle.queries || [];
    const mapped = bundle.results.map(r => ({
      index: r.cite_index,
      title: r.title,
      url: r.url,
      site: r.site_name || r.url,
    }));
    return { queries, results: mapped };
  }

  async _ensureSession(userText) {
    if (this.sessionPath) return;
    const dir = 'AI 会话';
    const date = todayDate();
    const title = titleFromUserText(userText);
    const base = `${dir}/${date} ${title}.md`;
    let path = base;
    let counter = 2;
    while (await this.vaultIO.exists(path)) {
      path = `${dir}/${date} ${title} (${counter}).md`;
      counter++;
    }
    const fm = makeFrontmatter({
      sessionId: this.sessionId,
      model: this.model,
      thinking: this.thinking,
      search: this.search,
    });
    await this.vaultIO.write(path, `---\n${fm}\n---\n\n`);
    this.sessionPath = path;
  }

  async _compact(md, parsed) {
    const messages = buildMessages(parsed, { tokenBudgetChars: this.tokenBudgetChars });
    const prompt = SUMMARY_PROMPT + messages.map(m => `${m.role}: ${m.content}`).join('\n\n');
    const response = await fetch(`${this.gatewayUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: this.model, messages: [{ role: 'user', content: prompt }] }),
    });
    if (!response.ok) return;
    const data = await response.json();
    const summaryText = data.choices?.[0]?.message?.content?.trim();
    if (!summaryText) return;
    const lastCoveredTurn = parsed.turns[parsed.turns.length - 2]?.id ?? parsed.turns[parsed.turns.length - 1]?.id ?? 0;
    const updated = writeSummary(md, lastCoveredTurn, summaryText);
    await this.vaultIO.write(this.sessionPath, updated);
    this.onEvent({ type: 'compacted', coversTurn: lastCoveredTurn });
  }

  async resume() {
    if (!this.sessionPath) return;
    const md = await this.vaultIO.read(this.sessionPath);
    const parsed = parseSession(md);
    const inProgress = parsed.turns.find(t => t.inProgress);
    if (!inProgress) return;
    const marker = `<!-- turn:${inProgress.id}`;
    const markerIdx = md.indexOf(marker);
    if (markerIdx === -1) return;
    const nextSep = md.indexOf('\n---\n', markerIdx);
    const endIdx = nextSep === -1 ? md.length : nextSep;
    const turnMd = md.slice(markerIdx, endIdx);
    if (turnMd.includes('<!-- ai:begin')) {
      const updatedTurn = turnMd.replace(
        /(<!-- ai:begin id=\d+ -->\n[\s\S]*?)(?=\n?<!-- ai:end -->|$)/,
        `$1\n\n> [!warning]- 本轮中断\n> 网络或进程异常，回复未完整生成。`
      ) + '\n\n<!-- ai:end -->';
      const updated = md.slice(0, markerIdx) + updatedTurn + md.slice(endIdx);
      await this.vaultIO.write(this.sessionPath, updated);
      this.onEvent({ type: 'resumed', turnId: inProgress.id });
    }
  }
}
