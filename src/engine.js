import { parseSession, serializeTurn, appendTurn, writeSummary, buildMessages } from './format.js';
import { SUMMARY_PROMPT } from './prompts.js';
import { OpenAICompatProvider } from './openai-compat-provider.js';
import { OpenClawProvider } from './openclaw-provider.js';

function todayDate() {
  return new Date().toISOString().slice(0, 10);
}

function nowIso() {
  return new Date().toISOString();
}

function sanitizeFilenameTitle(text) {
  // ponytail: 只处理最常见非法字符；不追求覆盖所有文件系统。
  // 升级路径：需要跨平台严格校验时引入 filename-sanitized 库。
  return text
    .slice(0, 30)
    .replace(/[\\/<>?:"|*\x00-\x1f]+/g, '_')
    .replace(/\s+/g, ' ')
    .replace(/[. ]+$/, '')
    .trim();
}

function titleFromUserText(text) {
  return sanitizeFilenameTitle(text);
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

function makeMeta({ turnId, userTextLen, model, usage, route }) {
  return {
    user_msg: String(userTextLen),
    ai_msg: String(turnId),
    model,
    route: route || 'local',
    tokens: usage ? String(usage.total_tokens) : '',
    time: nowIso(),
  };
}

export class SessionEngine {
  constructor({
    gatewayUrl,
    model,
    thinking,
    search,
    vaultIO,
    onEvent,
    tokenBudgetChars = 12000,
    provider,
    openclawUrl,
    openclawToken,
    clientId,
    route = 'local',
    sessionKey,
    agentId,
  }) {
    this.gatewayUrl = gatewayUrl ? gatewayUrl.replace(/\/$/, '') : '';
    this.model = model;
    this.thinking = thinking;
    this.search = search;
    this.vaultIO = vaultIO;
    this.onEvent = onEvent || (() => {});
    this.tokenBudgetChars = tokenBudgetChars;
    this.sessionPath = null;
    this.sessionId = crypto.randomUUID ? crypto.randomUUID() : `session-${Date.now()}`;
    this.abortController = null;
    this.route = route || 'local';
    this.agentId = agentId || '';
    this.sessionKey = sessionKey || (this.route === 'openclaw' ? `obsidian-${this.sessionId}` : '');
    this.provider = this._resolveProvider({
      provider,
      gatewayUrl,
      openclawUrl,
      openclawToken,
      clientId,
    });
  }

  _resolveProvider({ provider, gatewayUrl, openclawUrl, openclawToken, clientId }) {
    if (provider && typeof provider === 'object') {
      return provider;
    }
    const name = provider || 'openai-compat';
    if (name === 'openai-compat') {
      const isOpenclaw = this.route === 'openclaw';
      const url = isOpenclaw ? openclawUrl : gatewayUrl;
      const headers = {};
      if (isOpenclaw) {
        if (this.sessionKey) headers['x-openclaw-session-key'] = this.sessionKey;
        if (this.agentId) headers['x-openclaw-agent-id'] = this.agentId;
      }
      return new OpenAICompatProvider({
        gatewayUrl: url,
        apiKey: isOpenclaw ? openclawToken : '',
        headers,
      });
    }
    if (name === 'openclaw') {
      if (!openclawUrl) throw new Error('OpenClaw route requires openclawUrl');
      if (!openclawToken) throw new Error('OpenClaw route requires openclawToken');
      return new OpenClawProvider({
        url: openclawUrl,
        token: openclawToken,
        clientId: clientId || 'gateway-client',
      });
    }
    throw new Error(`unknown provider: ${name}`);
  }

  abort() {
    this.abortController?.abort();
  }

  async send(userText) {
    this.abortController = new AbortController();
    let turnId = null;
    try {
      await this._ensureSession(userText);
      const md = await this.vaultIO.read(this.sessionPath);
      const parsed = parseSession(md);

      turnId = (parsed.turns.length || 0) + 1;
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
      const stream = this.provider.streamChat({
        messages,
        model: this.model,
        thinking: this.thinking,
        search: this.search,
        signal: this.abortController.signal,
      });

      const { md: completed } = await this._consumeStream(stream, userTurn);
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
      if (this.abortController?.signal?.aborted) {
        await this._markAborted(turnId);
        this.onEvent({ type: 'turn-done', path: this.sessionPath, turnId });
        return { path: this.sessionPath };
      }
      this.onEvent({ type: 'error', error: err.message });
      throw err;
    } finally {
      this.abortController = null;
    }
  }

  async _consumeStream(stream, turn) {
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
    let bodyBuffer = '';
    let thinkBuffer = '';
    let searchResults = null;
    let usage = null;
    let lastFlushAt = performance.now();

    // ponytail: 流式 delta 先进入内存缓冲，按时间（150ms）或体积（4KB）批量落盘。
    // UI 回调不受批处理影响；崩溃恢复语义不变（无 ai:end 即进行中）。
    const FLUSH_INTERVAL_MS = 150;
    const FLUSH_SIZE_CHARS = 4096;

    const flush = async (force = false) => {
      const bufferedChars = bodyBuffer.length + thinkBuffer.length;
      if (!force && bufferedChars === 0) return;
      turnState.bodyBlocks = bodyBuffer ? bodyBuffer.split(/\n\n+/).map(s => s.trim()).filter(Boolean) : [];
      turnState.thinks = thinkBuffer ? [{ elapsedSecs: null, text: thinkBuffer }] : [];
      await this.vaultIO.write(this.sessionPath, prefix + serializeTurn(turnState));
      lastFlushAt = performance.now();
    };

    const maybeFlush = async () => {
      const bufferedChars = bodyBuffer.length + thinkBuffer.length;
      const elapsed = performance.now() - lastFlushAt;
      if (elapsed >= FLUSH_INTERVAL_MS || bufferedChars >= FLUSH_SIZE_CHARS) {
        await flush();
      }
    };

    for await (const result of stream) {
      if (result.type === 'content') {
        bodyBuffer += result.delta;
        turnState.bodyBlocks = bodyBuffer ? bodyBuffer.split(/\n\n+/).map(s => s.trim()).filter(Boolean) : [];
        this.onEvent({ type: 'content-delta', delta: result.delta });
        await maybeFlush();
      } else if (result.type === 'reasoning') {
        thinkBuffer += result.delta;
        turnState.thinks = thinkBuffer ? [{ elapsedSecs: null, text: thinkBuffer }] : [];
        this.onEvent({ type: 'think-delta', delta: result.delta });
        await maybeFlush();
      } else if (result.type === 'search_results') {
        searchResults = result.results;
        turnState.searches = [this._toSearchEntry(result.results)];
        this.onEvent({ type: 'search-done', results: result.results.results });
        await flush(true);
      } else if (result.type === 'finish') {
        usage = result.usage;
      }
    }

    // turn 结束时强制 flush，写入带 meta / ai:end 的最终版
    await flush(true);

    const finalTurn = {
      ...turnState,
      meta: makeMeta({ turnId: turn.id, userTextLen: turn.userText.length, model: this.model, usage, route: this.route }),
      inProgress: false,
    };
    return { md: prefix + serializeTurn(finalTurn) };
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
    await this.vaultIO.mkdir(dir);
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
    if (!this.gatewayUrl) return;
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

  async _markAborted(turnId) {
    if (!this.sessionPath || !turnId) return;
    const md = await this.vaultIO.read(this.sessionPath);
    const marker = `<!-- turn:${turnId}`;
    const markerIdx = md.indexOf(marker);
    if (markerIdx === -1) return;
    const nextSep = md.indexOf('\n---\n', markerIdx);
    const endIdx = nextSep === -1 ? md.length : nextSep;
    const turnMd = md.slice(markerIdx, endIdx);
    let updatedTurn;
    if (turnMd.includes('<!-- ai:begin')) {
      updatedTurn = turnMd.replace(
        /(<!-- ai:begin id=\d+ -->\n[\s\S]*?)(?=\n?<!-- ai:end -->|$)/,
        `$1\n\n> [!warning]- 本轮中断\n> 网络或进程异常，回复未完整生成。`
      ) + '\n\n<!-- ai:end -->';
    } else {
      const warning = '> [!warning]- 本轮中断\n> 网络或进程异常，回复未完整生成。';
      updatedTurn = `${turnMd}\n\n<!-- ai:begin id=${turnId} -->\n\n${warning}\n\n<!-- ai:end -->`;
    }
    const updated = md.slice(0, markerIdx) + updatedTurn + md.slice(endIdx);
    await this.vaultIO.write(this.sessionPath, updated);
    this.onEvent({ type: 'resumed', turnId });
  }

  async resume() {
    if (!this.sessionPath) return;
    const md = await this.vaultIO.read(this.sessionPath);
    const parsed = parseSession(md);
    const inProgress = parsed.turns.find(t => t.inProgress);
    if (!inProgress) return;
    await this._markAborted(inProgress.id);
  }
}
