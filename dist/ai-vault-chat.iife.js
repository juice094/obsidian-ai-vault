"use strict";
(() => {
  // src/format.js
  var FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---\r?\n/;
  var TURN_META_RE = /<!--\s*turn:(\d+)\s+([^>]+?)\s*-->/;
  var SUMMARY_RE = /<!--\s*summary\s+covers=(\d+)\s*-->/;
  var AI_BEGIN_RE = /<!--\s*ai:begin\s+id=(\d+)\s*-->/;
  var AI_END_RE = /<!--\s*ai:end\s*-->/;
  function parseFrontmatter(text) {
    const m = text.match(FRONTMATTER_RE);
    if (!m) return { frontmatter: {}, body: text };
    const fm = {};
    for (const line of m[1].split("\n")) {
      const idx = line.indexOf(":");
      if (idx === -1) continue;
      const key = line.slice(0, idx).trim();
      let value = line.slice(idx + 1).trim();
      if (value.startsWith('"') && value.endsWith('"') || value.startsWith("'") && value.endsWith("'")) {
        value = value.slice(1, -1);
      }
      fm[key] = value;
    }
    return { frontmatter: fm, body: text.slice(m[0].length) };
  }
  function parseCallout(lines, startIdx) {
    const first = lines[startIdx];
    const m = first.match(/>\s*\[!([^\]]+)\]([+-]?)\s*(.*)/);
    if (!m) return null;
    const [, type, toggle, titleLine] = m;
    const contentLines = [];
    let i = startIdx + 1;
    while (i < lines.length) {
      const line = lines[i];
      if (!line.trim().startsWith(">")) break;
      contentLines.push(line.replace(/^>\s?/, ""));
      i++;
    }
    return {
      type,
      toggle,
      title: titleLine.trim(),
      content: contentLines.join("\n").trim(),
      endIdx: i
    };
  }
  function parseSearchCallout(title, content) {
    const titleMatch = title.match(/已阅读\s+(\d+)\s+个网页\s+·\s+"([^"]+)"/);
    const queries = titleMatch ? [titleMatch[2]] : [];
    const results = [];
    const lines = content.split("\n");
    for (const line of lines) {
      const m = line.match(/^(\d+)\.\s*\[([^\]]+)\]\(([^)]+)\)\s*—\s*([^\n]+)/);
      if (m) {
        results.push({
          index: parseInt(m[1], 10),
          title: m[2],
          url: m[3],
          site: m[4].trim()
        });
      }
    }
    return { queries, results };
  }
  function parseThinkCallout(title, content) {
    const m = title.match(/已思考\s+·\s+(\d+)\s*秒/);
    return {
      elapsedSecs: m ? parseInt(m[1], 10) : null,
      text: content.trim()
    };
  }
  function parseSummaryCallout(title, content) {
    const m = title.match(/前情摘要\s*（覆盖至第\s*(\d+)\s*轮\s*）/);
    return {
      coversTurn: m ? parseInt(m[1], 10) : null,
      text: content.trim()
    };
  }
  function parseTurn(sectionText) {
    var _a;
    const lines = sectionText.split("\n");
    let i = 0;
    let meta = null;
    let turnId = null;
    const turnMetaMatch = (_a = lines[i]) == null ? void 0 : _a.match(TURN_META_RE);
    if (turnMetaMatch) {
      turnId = parseInt(turnMetaMatch[1], 10);
      meta = {};
      for (const kv of turnMetaMatch[2].trim().split(/\s+/)) {
        const [k, v] = kv.split("=");
        if (k && v) meta[k] = v;
      }
      i++;
    }
    let userText = "";
    const thinks = [];
    const searches = [];
    let bodyStart = -1;
    let bodyEnd = -1;
    let aiBeginId = null;
    while (i < lines.length) {
      const line = lines[i];
      if (line.trim().startsWith(">")) {
        const callout = parseCallout(lines, i);
        if (!callout) {
          i++;
          continue;
        }
        i = callout.endIdx;
        if (callout.type === "user") {
          userText = callout.content;
        } else if (callout.type === "think") {
          thinks.push(parseThinkCallout(callout.title, callout.content));
        } else if (callout.type === "search") {
          searches.push(parseSearchCallout(callout.title, callout.content));
        }
        continue;
      }
      const beginMatch = line.match(AI_BEGIN_RE);
      if (beginMatch) {
        bodyStart = i;
        aiBeginId = parseInt(beginMatch[1], 10);
        i++;
        continue;
      }
      const endMatch = line.match(AI_END_RE);
      if (endMatch && bodyStart !== -1) {
        bodyEnd = i;
        i++;
        continue;
      }
      i++;
    }
    const inProgress = bodyStart !== -1 && bodyEnd === -1;
    const bodyBlocks = [];
    if (bodyStart !== -1) {
      const endLine = bodyEnd === -1 ? lines.length : bodyEnd;
      const raw = lines.slice(bodyStart + 1, endLine).join("\n").trim();
      if (raw) bodyBlocks.push(...raw.split(/\n\n+/).map((s) => s.trim()).filter(Boolean));
    }
    return {
      id: turnId,
      userText,
      thinks,
      searches,
      bodyBlocks,
      meta,
      inProgress,
      aiBeginId
    };
  }
  function parseSession(mdText) {
    const { frontmatter, body } = parseFrontmatter(mdText);
    const sections = body.split(/\r?\n---\r?\n/).map((s) => s.trim()).filter(Boolean);
    let summary = null;
    const turns = [];
    for (const section of sections) {
      const lines = section.split("\n");
      const summaryMatch = section.match(SUMMARY_RE);
      if (summaryMatch) {
        for (let i = 0; i < lines.length; i++) {
          if (lines[i].trim().startsWith(">")) {
            const callout = parseCallout(lines, i);
            if (callout && callout.type === "summary") {
              const parsed = parseSummaryCallout(callout.title, callout.content);
              summary = {
                coversTurn: parseInt(summaryMatch[1], 10),
                text: parsed.text
              };
            }
            break;
          }
        }
        continue;
      }
      const turn = parseTurn(section);
      if (turn.id !== null || turn.userText || turn.bodyBlocks.length) {
        turns.push(turn);
      }
    }
    return { frontmatter, summary, turns };
  }
  function serializeCallout(type, toggle, title, content) {
    const marker = toggle ? `[!${type}]${toggle}` : `[!${type}]`;
    const lines = content ? content.split("\n") : [];
    const body = lines.map((l) => `> ${l}`).join("\n");
    const heading = title ? `> ${marker} ${title}` : `> ${marker}`;
    if (!body) return heading;
    return `${heading}
${body}`;
  }
  function serializeTurn(turn) {
    var _a, _b, _c;
    const parts = [];
    if (turn.id !== null && turn.meta) {
      const metaPairs = Object.entries(turn.meta).map(([k, v]) => `${k}=${v}`).join(" ");
      parts.push(`<!-- turn:${turn.id} ${metaPairs} -->`);
    }
    if (turn.userText) {
      parts.push(serializeCallout("user", "", "", turn.userText));
    }
    for (const search of turn.searches) {
      const resultLines = search.results.map(
        (r, idx) => `${idx + 1}. [${r.title}](${r.url}) \u2014 ${r.site}`
      );
      const query = search.queries[0] || "";
      const title = `\u5DF2\u9605\u8BFB ${search.results.length} \u4E2A\u7F51\u9875 \xB7 "${query}"`;
      parts.push(serializeCallout("search", "-", title, resultLines.join("\n")));
    }
    for (const think of turn.thinks) {
      const secs = (_a = think.elapsedSecs) != null ? _a : "N";
      const title = `\u5DF2\u601D\u8003 \xB7 ${secs} \u79D2`;
      parts.push(serializeCallout("think", "-", title, think.text));
    }
    if (turn.bodyBlocks.length) {
      parts.push(`<!-- ai:begin id=${(_c = (_b = turn.aiBeginId) != null ? _b : turn.id) != null ? _c : ""} -->`);
      parts.push(turn.bodyBlocks.join("\n\n"));
      if (!turn.inProgress) {
        parts.push("<!-- ai:end -->");
      }
    }
    return parts.join("\n\n");
  }
  function appendTurn(mdText, turn) {
    const serialized = serializeTurn(turn);
    if (!serialized) return mdText;
    const trimmed = mdText.trimEnd();
    if (trimmed === "") return serialized;
    if (trimmed.endsWith("---")) {
      return `${trimmed}

${serialized}`;
    }
    return `${trimmed}

---

${serialized}`;
  }
  function writeSummary(mdText, coversTurn, summaryText) {
    const { frontmatter, body } = parseFrontmatter(mdText);
    const summaryBlock = `<!-- summary covers=${coversTurn} -->

${serializeCallout("summary", "+", `\u524D\u60C5\u6458\u8981\uFF08\u8986\u76D6\u81F3\u7B2C ${coversTurn} \u8F6E\uFF09`, summaryText)}`;
    if (!body.trim()) {
      return frontmatterText(frontmatter) + summaryBlock;
    }
    const cleaned = body.replace(/<!--\s*summary\s+covers=\d+\s*-->\r?\n[\s\S]*?(?=\r?\n---\r?\n|$)/, "").trim();
    return frontmatterText(frontmatter) + summaryBlock + "\n\n---\n\n" + cleaned;
  }
  function frontmatterText(frontmatter) {
    const entries = Object.entries(frontmatter);
    if (!entries.length) return "";
    const lines = entries.map(([k, v]) => `${k}: ${v}`);
    return `---
${lines.join("\n")}
---

`;
  }
  function buildMessages(parsed, { tokenBudgetChars }) {
    const messages = [];
    const budget = tokenBudgetChars != null ? tokenBudgetChars : Infinity;
    const includedTurns = parsed.turns.filter((t) => !t.inProgress);
    const startTurn = parsed.summary ? parsed.summary.coversTurn : 0;
    if (parsed.summary) {
      messages.push({ role: "user", content: `\u524D\u60C5\u6458\u8981\uFF1A${parsed.summary.text}` });
    }
    const turnPairs = [];
    for (const turn of includedTurns) {
      if (turn.id !== null && turn.id <= startTurn) continue;
      const pair = [];
      if (turn.userText) {
        pair.push({ role: "user", content: turn.userText });
      }
      const body = turn.bodyBlocks.join("\n\n");
      if (body) {
        pair.push({ role: "assistant", content: body });
      }
      if (pair.length) turnPairs.push(pair);
    }
    let totalChars = messages.reduce((sum, m) => sum + m.content.length, 0);
    const kept = [];
    for (let i = turnPairs.length - 1; i >= 0; i--) {
      const pair = turnPairs[i];
      const pairChars = pair.reduce((sum, m) => sum + m.content.length, 0);
      if (totalChars + pairChars > budget) {
        break;
      }
      kept.unshift(...pair);
      totalChars += pairChars;
    }
    messages.push(...kept);
    return messages;
  }

  // src/prompts.js
  var SUMMARY_PROMPT = `\u8BF7\u628A\u4EE5\u4E0B AI \u4E0E\u7528\u6237\u7684\u591A\u8F6E\u5BF9\u8BDD\u6D53\u7F29\u6210\u4E00\u6BB5\u524D\u60C5\u6458\u8981\u3002\u6458\u8981\u7528\u4E8E\u540E\u7EED\u5BF9\u8BDD\u65F6\u6062\u590D\u4E0A\u4E0B\u6587\uFF0C\u9700\u4FDD\u7559\u5173\u952E\u4E8B\u5B9E\u3001\u7528\u6237\u76EE\u6807\u548C\u7ED3\u8BBA\uFF0C\u7701\u7565\u5177\u4F53\u63AA\u8F9E\u548C\u793C\u8C8C\u7528\u8BED\u3002\u53EA\u8F93\u51FA\u6458\u8981\u6B63\u6587\uFF0C\u4E0D\u8981\u52A0\u6807\u9898\u6216\u989D\u5916\u89E3\u91CA\u3002

\u5BF9\u8BDD\u5185\u5BB9\uFF1A
`;

  // src/engine.js
  function todayDate() {
    return (/* @__PURE__ */ new Date()).toISOString().slice(0, 10);
  }
  function nowIso() {
    return (/* @__PURE__ */ new Date()).toISOString();
  }
  function titleFromUserText(text) {
    return text.slice(0, 20).replace(/\s+/g, " ").trim();
  }
  function makeFrontmatter({ sessionId, model, thinking, search }) {
    const fm = {
      chat_format: "1",
      session_id: sessionId,
      model,
      thinking: String(thinking),
      search: String(search),
      created: nowIso()
    };
    return Object.entries(fm).map(([k, v]) => `${k}: ${v}`).join("\n");
  }
  function makeMeta({ turnId, userTextLen, model, usage }) {
    return {
      user_msg: String(userTextLen),
      ai_msg: String(turnId),
      model,
      tokens: usage ? String(usage.total_tokens) : "",
      time: nowIso()
    };
  }
  var SessionEngine = class {
    constructor({ gatewayUrl, model, thinking, search, vaultIO, onEvent, tokenBudgetChars = 12e3 }) {
      this.gatewayUrl = gatewayUrl.replace(/\/$/, "");
      this.model = model;
      this.thinking = thinking;
      this.search = search;
      this.vaultIO = vaultIO;
      this.onEvent = onEvent || (() => {
      });
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
          aiBeginId: null
        };
        let updated = appendTurn(md, userTurn);
        await this.vaultIO.write(this.sessionPath, updated);
        this.onEvent({ type: "user-saved", path: this.sessionPath });
        const messages = buildMessages(parseSession(updated), { tokenBudgetChars: this.tokenBudgetChars });
        const payload = {
          model: this.model,
          messages,
          stream: true
        };
        const response = await fetch(`${this.gatewayUrl}/v1/chat/completions`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload)
        });
        if (!response.ok) {
          throw new Error(`gateway error ${response.status}: ${await response.text()}`);
        }
        const { md: completed } = await this._consumeStream(response, userTurn);
        await this.vaultIO.write(this.sessionPath, completed);
        const afterParse = parseSession(completed);
        const checkMessages = buildMessages(afterParse, { tokenBudgetChars: this.tokenBudgetChars });
        const totalChars = checkMessages.reduce((s, m) => s + m.content.length, 0);
        if (totalChars > this.tokenBudgetChars && afterParse.turns.length > 1) {
          await this._compact(completed, afterParse);
        }
        this.onEvent({ type: "turn-done", path: this.sessionPath, turnId });
        return { path: this.sessionPath };
      } catch (err) {
        this.onEvent({ type: "error", error: err.message });
        throw err;
      }
    }
    async _consumeStream(response, turn) {
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buf = "";
      let baseMd = await this.vaultIO.read(this.sessionPath);
      const marker = `<!-- turn:${turn.id}`;
      const markerIdx = baseMd.indexOf(marker);
      if (markerIdx === -1) throw new Error("turn marker missing");
      const prefix = baseMd.slice(0, markerIdx);
      const turnState = {
        ...turn,
        thinks: [],
        searches: [],
        bodyBlocks: [],
        aiBeginId: turn.id
      };
      let bodyText = "";
      let thinkText = "";
      let searchResults = null;
      let usage = null;
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        const lines = buf.split("\n");
        buf = lines.pop();
        for (const line of lines) {
          const result = this._processSseLine(line);
          if (!result) continue;
          if (result.type === "content") {
            bodyText += result.delta;
            turnState.bodyBlocks = bodyText ? bodyText.split(/\n\n+/).map((s) => s.trim()).filter(Boolean) : [];
            this.onEvent({ type: "content-delta", delta: result.delta });
          } else if (result.type === "reasoning") {
            thinkText += result.delta;
            turnState.thinks = thinkText ? [{ elapsedSecs: null, text: thinkText }] : [];
            this.onEvent({ type: "think-delta", delta: result.delta });
          } else if (result.type === "search_results") {
            searchResults = result.results;
            turnState.searches = [this._toSearchEntry(result.results)];
            this.onEvent({ type: "search-done", results: result.results.results });
          } else if (result.type === "finish") {
            usage = result.usage;
          }
          await this.vaultIO.write(this.sessionPath, prefix + serializeTurn(turnState));
        }
      }
      const finalTurn = {
        ...turnState,
        meta: makeMeta({ turnId: turn.id, userTextLen: turn.userText.length, model: this.model, usage }),
        inProgress: false
      };
      return { md: prefix + serializeTurn(finalTurn) };
    }
    _processSseLine(line) {
      var _a, _b, _c, _d, _e, _f;
      const trimmed = line.trim();
      if (!trimmed.startsWith("data:")) return null;
      const data = trimmed.slice(5).trim();
      if (data === "[DONE]") return { type: "done" };
      try {
        const chunk = JSON.parse(data);
        const delta = (_b = (_a = chunk.choices) == null ? void 0 : _a[0]) == null ? void 0 : _b.delta;
        if (!delta) {
          if ((_d = (_c = chunk.choices) == null ? void 0 : _c[0]) == null ? void 0 : _d.finish_reason) {
            return { type: "finish", usage: chunk.usage };
          }
          return null;
        }
        if (delta.content) return { type: "content", delta: delta.content };
        if (delta.reasoning_content) return { type: "reasoning", delta: delta.reasoning_content };
        if (delta.search_results) return { type: "search_results", results: delta.search_results };
        if ((_f = (_e = chunk.choices) == null ? void 0 : _e[0]) == null ? void 0 : _f.finish_reason) {
          return { type: "finish", usage: chunk.usage };
        }
        return null;
      } catch (e) {
        return null;
      }
    }
    _toSearchEntry(bundle) {
      const queries = bundle.queries || [];
      const mapped = bundle.results.map((r) => ({
        index: r.cite_index,
        title: r.title,
        url: r.url,
        site: r.site_name || r.url
      }));
      return { queries, results: mapped };
    }
    async _ensureSession(userText) {
      if (this.sessionPath) return;
      const dir = "AI \u4F1A\u8BDD";
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
        search: this.search
      });
      await this.vaultIO.write(path, `---
${fm}
---

`);
      this.sessionPath = path;
    }
    async _compact(md, parsed) {
      var _a, _b, _c, _d, _e, _f, _g, _h;
      const messages = buildMessages(parsed, { tokenBudgetChars: this.tokenBudgetChars });
      const prompt = SUMMARY_PROMPT + messages.map((m) => `${m.role}: ${m.content}`).join("\n\n");
      const response = await fetch(`${this.gatewayUrl}/v1/chat/completions`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model: this.model, messages: [{ role: "user", content: prompt }] })
      });
      if (!response.ok) return;
      const data = await response.json();
      const summaryText = (_d = (_c = (_b = (_a = data.choices) == null ? void 0 : _a[0]) == null ? void 0 : _b.message) == null ? void 0 : _c.content) == null ? void 0 : _d.trim();
      if (!summaryText) return;
      const lastCoveredTurn = (_h = (_g = (_e = parsed.turns[parsed.turns.length - 2]) == null ? void 0 : _e.id) != null ? _g : (_f = parsed.turns[parsed.turns.length - 1]) == null ? void 0 : _f.id) != null ? _h : 0;
      const updated = writeSummary(md, lastCoveredTurn, summaryText);
      await this.vaultIO.write(this.sessionPath, updated);
      this.onEvent({ type: "compacted", coversTurn: lastCoveredTurn });
    }
    async resume() {
      if (!this.sessionPath) return;
      const md = await this.vaultIO.read(this.sessionPath);
      const parsed = parseSession(md);
      const inProgress = parsed.turns.find((t) => t.inProgress);
      if (!inProgress) return;
      const marker = `<!-- turn:${inProgress.id}`;
      const markerIdx = md.indexOf(marker);
      if (markerIdx === -1) return;
      const nextSep = md.indexOf("\n---\n", markerIdx);
      const endIdx = nextSep === -1 ? md.length : nextSep;
      const turnMd = md.slice(markerIdx, endIdx);
      if (turnMd.includes("<!-- ai:begin")) {
        const updatedTurn = turnMd.replace(
          /(<!-- ai:begin id=\d+ -->\n[\s\S]*?)(?=\n?<!-- ai:end -->|$)/,
          `$1

> [!warning]- \u672C\u8F6E\u4E2D\u65AD
> \u7F51\u7EDC\u6216\u8FDB\u7A0B\u5F02\u5E38\uFF0C\u56DE\u590D\u672A\u5B8C\u6574\u751F\u6210\u3002`
        ) + "\n\n<!-- ai:end -->";
        const updated = md.slice(0, markerIdx) + updatedTurn + md.slice(endIdx);
        await this.vaultIO.write(this.sessionPath, updated);
        this.onEvent({ type: "resumed", turnId: inProgress.id });
      }
    }
  };

  // src/browser-entry.js
  window.AiVaultChat = {
    SessionEngine,
    parseSession,
    serializeTurn,
    appendTurn,
    writeSummary,
    buildMessages
  };
})();
