"use strict";
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);

// main.ts
var main_exports = {};
__export(main_exports, {
  default: () => AiVaultChatPlugin
});
module.exports = __toCommonJS(main_exports);
var import_obsidian = require("obsidian");

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
    parts.push(serializeCallout("user", "", "\u4F60", turn.userText));
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
var WIKILINK_RE = /\[\[([^|\]\n]+?)(?:\|[^\]\n]+?)?\]\]/g;
function extractWikilinks(text) {
  const seen = /* @__PURE__ */ new Set();
  const results = [];
  for (const m of text.matchAll(WIKILINK_RE)) {
    const name = m[1].trim();
    if (!seen.has(name)) {
      seen.add(name);
      results.push(name);
    }
  }
  return results;
}
async function resolveWikilinks(userText, vaultIO, { budgetChars = 6e3, onMissing }) {
  const links = extractWikilinks(userText);
  if (links.length === 0) return { contextMessages: [], missing: [] };
  const contextParts = [];
  const missing = [];
  let usedChars = 0;
  for (const link of links) {
    if (usedChars >= budgetChars) break;
    const path = `${link}.md`;
    const exists = await vaultIO.exists(path);
    if (!exists) {
      missing.push(link);
      continue;
    }
    const content = await vaultIO.read(path);
    if (!content) {
      missing.push(link);
      continue;
    }
    const remaining = budgetChars - usedChars;
    let body = content;
    let truncated = false;
    if (body.length > remaining) {
      body = body.slice(0, remaining) + "\n\uFF08\u5DF2\u622A\u65AD\uFF09";
      truncated = true;
    }
    usedChars += body.length;
    contextParts.push({ link, content: body, truncated });
  }
  if (missing.length > 0 && onMissing) {
    onMissing(missing);
  }
  if (contextParts.length === 0) return { contextMessages: [], missing };
  const systemContent = contextParts.map((p) => `\u53C2\u8003\u7B14\u8BB0\u300A${p.link}\u300B\uFF1A
${p.content}`).join("\n\n---\n\n");
  return {
    contextMessages: [{ role: "system", content: systemContent }],
    missing
  };
}
function buildMessages(parsed, { tokenBudgetChars, contextMessages = [] }) {
  const messages = [];
  const budget = tokenBudgetChars != null ? tokenBudgetChars : Infinity;
  const includedTurns = parsed.turns.filter((t) => !t.inProgress);
  const startTurn = parsed.summary ? parsed.summary.coversTurn : 0;
  if (parsed.summary) {
    messages.push({ role: "user", content: `\u524D\u60C5\u6458\u8981\uFF1A${parsed.summary.text}` });
  }
  messages.push(...contextMessages);
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

// src/openai-compat-provider.js
var OpenAICompatProvider = class {
  constructor({ gatewayUrl, apiKey, headers }) {
    this.gatewayUrl = gatewayUrl.replace(/\/$/, "");
    this.apiKey = apiKey || "";
    this.extraHeaders = headers || {};
  }
  async *streamChat({ messages, model, thinking, search, signal }) {
    const payload = {
      model,
      messages,
      stream: true
    };
    const headers = {
      "Content-Type": "application/json",
      ...this.extraHeaders
    };
    if (this.apiKey) headers["Authorization"] = `Bearer ${this.apiKey}`;
    const response = await fetch(`${this.gatewayUrl}/v1/chat/completions`, {
      method: "POST",
      headers,
      body: JSON.stringify(payload),
      signal
    });
    if (!response.ok) {
      throw new Error(`gateway error ${response.status}: ${await response.text()}`);
    }
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buf = "";
    const toolBuffers = /* @__PURE__ */ new Map();
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        const lines = buf.split("\n");
        buf = lines.pop();
        for (const line of lines) {
          const results = this._processSseLine(line, toolBuffers);
          if (results) {
            for (const result of Array.isArray(results) ? results : [results]) {
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
    var _a, _b, _c, _d;
    const trimmed = line.trim();
    if (!trimmed.startsWith("data:")) return null;
    const data = trimmed.slice(5).trim();
    if (data === "[DONE]") return null;
    try {
      const chunk = JSON.parse(data);
      const choice = (_a = chunk.choices) == null ? void 0 : _a[0];
      const delta = choice == null ? void 0 : choice.delta;
      const finishReason = choice == null ? void 0 : choice.finish_reason;
      if (delta == null ? void 0 : delta.tool_calls) {
        for (const tc of delta.tool_calls) {
          const idx = (_b = tc.index) != null ? _b : 0;
          const existing = toolBuffers.get(idx) || { id: "", type: "", name: "", args: "" };
          if (tc.id) existing.id = tc.id;
          if (tc.type) existing.type = tc.type;
          if ((_c = tc.function) == null ? void 0 : _c.name) existing.name = tc.function.name;
          if ((_d = tc.function) == null ? void 0 : _d.arguments) existing.args += tc.function.arguments;
          toolBuffers.set(idx, existing);
        }
      }
      if (finishReason === "tool_calls") {
        const queries = [];
        for (const tc of toolBuffers.values()) {
          let args = {};
          try {
            args = JSON.parse(tc.args);
          } catch (e) {
          }
          const query = args.query || args.q || args.search || tc.name;
          if (query) queries.push(query);
        }
        toolBuffers.clear();
        const events = [];
        if (queries.length > 0) {
          events.push({ type: "search_results", results: { queries, results: [] } });
        }
        events.push({ type: "finish", usage: chunk.usage });
        return events;
      }
      if (delta == null ? void 0 : delta.content) return { type: "content", delta: delta.content };
      if (delta == null ? void 0 : delta.reasoning_content) return { type: "reasoning", delta: delta.reasoning_content };
      if (delta == null ? void 0 : delta.search_results) return { type: "search_results", results: delta.search_results };
      if (finishReason) {
        return { type: "finish", usage: chunk.usage };
      }
      return null;
    } catch (e) {
      return null;
    }
  }
};

// src/openclaw-provider.js
var DEFAULT_CLIENT_ID = "cli";
var DEFAULT_SESSION_KEY = "agent:main:main";
var DEFAULT_SCOPES = ["operator.read", "operator.write"];
var OpenClawProvider = class {
  constructor({
    url,
    token,
    clientId = DEFAULT_CLIENT_ID,
    sessionKey = DEFAULT_SESSION_KEY,
    simpleConnect = false
  }) {
    if (!token) throw new Error("OpenClaw token required");
    this.url = url;
    this.token = token;
    this.clientId = clientId;
    this.sessionKey = sessionKey;
    this.simpleConnect = simpleConnect;
  }
  async *streamChat({ messages, model, thinking, search, signal }) {
    var _a, _b;
    if (signal == null ? void 0 : signal.aborted) {
      throw new DOMException("Aborted", "AbortError");
    }
    const token = this.token;
    const url = this.url;
    const ws = new WebSocket(url);
    const events = [];
    let deferred = null;
    let done = false;
    let error = null;
    const push = (ev) => {
      if (done) return;
      events.push(ev);
      if (deferred) {
        deferred.resolve();
        deferred = null;
      }
    };
    const fail = (err) => {
      if (done) return;
      error = err;
      done = true;
      if (deferred) {
        deferred.reject(err);
        deferred = null;
      }
    };
    const finish = () => {
      if (done) return;
      done = true;
      if (deferred) {
        deferred.resolve();
        deferred = null;
      }
    };
    const onMessage = (ev) => {
      let parsed;
      try {
        parsed = JSON.parse(ev.data);
      } catch (e) {
        return;
      }
      push({ type: "message", parsed });
    };
    const onError = (err) => {
      fail(new Error(`websocket error: ${err.message || String(err)}`));
    };
    const onClose = () => finish();
    ws.addEventListener("message", onMessage);
    ws.addEventListener("error", onError);
    ws.addEventListener("close", onClose);
    if (this.simpleConnect) {
      ws.addEventListener("open", () => {
        send({ type: "connect", token });
      });
    }
    const abortHandler = () => {
      if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) {
        ws.close(1e3, "abort");
      }
      fail(new DOMException("Aborted", "AbortError"));
    };
    signal == null ? void 0 : signal.addEventListener("abort", abortHandler);
    const nextEvent = () => {
      if (events.length) return Promise.resolve(events.shift());
      if (error) return Promise.reject(error);
      if (done) return Promise.resolve(null);
      let resolve, reject;
      const p = new Promise((res, rej) => {
        resolve = res;
        reject = rej;
      });
      deferred = { resolve, reject };
      return p.then(() => {
        if (error) throw error;
        if (events.length) return events.shift();
        return null;
      });
    };
    const send = (obj) => {
      ws.send(JSON.stringify(obj));
    };
    const randId = () => {
      var _a2;
      if ((_a2 = globalThis.crypto) == null ? void 0 : _a2.randomUUID) return globalThis.crypto.randomUUID();
      return `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    };
    const lastUserContent = () => {
      var _a2;
      for (let i = messages.length - 1; i >= 0; i--) {
        if (messages[i].role === "user") return messages[i].content;
      }
      return ((_a2 = messages[messages.length - 1]) == null ? void 0 : _a2.content) || "";
    };
    try {
      if (!this.simpleConnect) {
        while (true) {
          const msg = await nextEvent();
          if (!msg) throw new Error("OpenClaw connection closed before challenge");
          const { parsed } = msg;
          if (parsed.type === "event" && parsed.event === "connect.challenge") {
            const connectReqId = randId();
            send({
              type: "req",
              id: connectReqId,
              method: "connect",
              params: {
                minProtocol: 3,
                maxProtocol: 3,
                client: {
                  id: this.clientId,
                  version: "1.0.0",
                  platform: "linux",
                  mode: "cli"
                },
                role: "operator",
                scopes: DEFAULT_SCOPES,
                auth: { token },
                caps: []
              }
            });
            break;
          }
        }
      }
      while (true) {
        const msg = await nextEvent();
        if (!msg) throw new Error("OpenClaw connection closed before hello-ok");
        const { parsed } = msg;
        if (this._isConnectError(parsed)) {
          throw new Error(`OpenClaw connect failed: ${((_a = parsed.error) == null ? void 0 : _a.message) || parsed.message || "unknown"}`);
        }
        if (this._isHelloOk(parsed)) break;
      }
      const chatReqId = randId();
      send({
        type: "req",
        id: chatReqId,
        method: "chat.send",
        params: {
          idempotencyKey: randId(),
          sessionKey: this.sessionKey,
          message: lastUserContent()
        }
      });
      let finished = false;
      while (!finished) {
        const msg = await nextEvent();
        if (!msg) break;
        const { parsed } = msg;
        if (parsed.type === "res" && parsed.id === chatReqId) {
          if (!parsed.ok) {
            throw new Error(`OpenClaw chat.send failed: ${((_b = parsed.error) == null ? void 0 : _b.message) || "unknown"}`);
          }
          continue;
        }
        const ev = this._mapEvent(parsed);
        if (ev) {
          yield ev;
          if (ev.type === "finish") finished = true;
        }
      }
    } finally {
      signal == null ? void 0 : signal.removeEventListener("abort", abortHandler);
      if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) {
        ws.close(1e3, "stream end");
      }
    }
  }
  _isHelloOk(parsed) {
    var _a;
    if (!parsed || typeof parsed !== "object") return false;
    if (parsed.type === "res" && parsed.ok && ((_a = parsed.payload) == null ? void 0 : _a.type) === "hello-ok") return true;
    if (this.simpleConnect) {
      if (parsed.type === "hello-ok" || parsed.type === "connected") return true;
      if (parsed.event === "hello-ok" || parsed.event === "connected") return true;
      if (parsed.type === "res" && parsed.ok) return true;
    }
    return false;
  }
  _isConnectError(parsed) {
    if (!parsed || typeof parsed !== "object") return false;
    if (parsed.type === "res" && parsed.ok === false) return true;
    if (this.simpleConnect && (parsed.type === "error" || parsed.error)) return true;
    return false;
  }
  _mapEvent(parsed) {
    var _a, _b, _c;
    const event = parsed.event;
    const payload = parsed.payload;
    if (!payload) return null;
    if (event === "ChatChunk" || event === "chat") {
      const delta = payload.delta;
      if (delta) {
        if (delta.content) return { type: "content", delta: delta.content };
        if (delta.reasoning) return { type: "reasoning", delta: delta.reasoning };
        if (delta.text) return { type: "content", delta: delta.text };
      }
      if ((_a = payload.message) == null ? void 0 : _a.content) {
        return { type: "content", delta: payload.message.content };
      }
      if (payload.content) {
        return { type: "content", delta: payload.content };
      }
    }
    if (event === "ReasoningChunk") {
      const delta = payload.delta;
      if (delta) {
        if (delta.reasoning) return { type: "reasoning", delta: delta.reasoning };
        if (delta.content) return { type: "reasoning", delta: delta.content };
        if (delta.text) return { type: "reasoning", delta: delta.text };
      }
      if (payload.reasoning) return { type: "reasoning", delta: payload.reasoning };
      if ((_b = payload.message) == null ? void 0 : _b.content) return { type: "reasoning", delta: payload.message.content };
    }
    if (event === "agent") {
      const data = payload.data;
      if (payload.stream === "lifecycle" && (data == null ? void 0 : data.phase) === "end") {
        return { type: "finish" };
      }
      if (data) {
        if (payload.stream === "reasoning" || payload.stream === "think") {
          if (data.delta) return { type: "reasoning", delta: data.delta };
          if (data.text) return { type: "reasoning", delta: data.text };
        }
        if (data.delta) return { type: "content", delta: data.delta };
        if (data.text) return { type: "content", delta: data.text };
      }
      if (payload.done === true || payload.finished === true) {
        return { type: "finish" };
      }
    }
    if (event === "chat") {
      if (payload.state === "final") return { type: "finish" };
      const content = (_c = payload.message) == null ? void 0 : _c.content;
      if (typeof content === "string") return { type: "content", delta: content };
      if (Array.isArray(content)) {
        const text = content.filter((c) => c.type === "text").map((c) => c.text).join("");
        if (text) return { type: "content", delta: text };
      }
    }
    if (event === "Done" || payload.done === true) {
      return { type: "finish" };
    }
    if (payload.search_results) {
      return { type: "search_results", results: payload.search_results };
    }
    return null;
  }
};

// src/engine.js
function todayDate() {
  return (/* @__PURE__ */ new Date()).toISOString().slice(0, 10);
}
function nowIso() {
  return (/* @__PURE__ */ new Date()).toISOString();
}
function sanitizeFilenameTitle(text) {
  return text.slice(0, 30).replace(/[\\/<>?:"|*\x00-\x1f]+/g, "_").replace(/\s+/g, " ").replace(/[. ]+$/, "").trim();
}
function titleFromUserText(text) {
  return sanitizeFilenameTitle(text);
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
function makeMeta({ turnId, userTextLen, model, usage, route, peerAgent, sessionEntry }) {
  const meta = {
    user_msg: String(userTextLen),
    ai_msg: String(turnId),
    model,
    route: route || "local",
    tokens: usage ? String(usage.total_tokens) : "",
    time: nowIso()
  };
  if (route === "openclaw") {
    if (peerAgent) meta.agent = peerAgent;
    if (sessionEntry) meta.entry = sessionEntry;
  }
  return meta;
}
var SessionEngine = class {
  constructor({
    gatewayUrl,
    model,
    thinking,
    search,
    vaultIO,
    onEvent,
    tokenBudgetChars = 12e3,
    provider,
    openclawUrl,
    openclawToken,
    clientId,
    route = "local",
    sessionKey,
    agentId,
    peerAgent = "main",
    sessionEntry = "note"
  }) {
    this.gatewayUrl = gatewayUrl ? gatewayUrl.replace(/\/$/, "") : "";
    this.model = model;
    this.thinking = thinking;
    this.search = search;
    this.vaultIO = vaultIO;
    this.onEvent = onEvent || (() => {
    });
    this.tokenBudgetChars = tokenBudgetChars;
    this.sessionPath = null;
    this.sessionId = crypto.randomUUID ? crypto.randomUUID() : `session-${Date.now()}`;
    this.abortController = null;
    this.route = route || "local";
    this.peerAgent = peerAgent || "main";
    this.agentId = agentId || (this.peerAgent === "device" ? "device" : "gray");
    this.sessionEntry = sessionEntry || "note";
    if (sessionKey) {
      this.sessionKey = sessionKey;
    } else if (this.route === "openclaw") {
      this.sessionKey = this.sessionEntry === "main" ? "agent:main:main" : `obsidian-${this.sessionId}`;
    } else {
      this.sessionKey = "";
    }
    this.provider = this._resolveProvider({
      provider,
      gatewayUrl,
      openclawUrl,
      openclawToken,
      clientId
    });
  }
  _resolveProvider({ provider, gatewayUrl, openclawUrl, openclawToken, clientId }) {
    if (provider && typeof provider === "object") {
      return provider;
    }
    const name = provider || "openai-compat";
    if (name === "openai-compat") {
      const isOpenclaw = this.route === "openclaw";
      const url = isOpenclaw ? openclawUrl : gatewayUrl;
      const headers = {};
      if (isOpenclaw) {
        if (this.sessionKey) headers["x-openclaw-session-key"] = this.sessionKey;
        if (this.agentId) headers["x-openclaw-agent-id"] = this.agentId;
      }
      return new OpenAICompatProvider({
        gatewayUrl: url,
        apiKey: isOpenclaw ? openclawToken : "",
        headers
      });
    }
    if (name === "openclaw") {
      if (!openclawUrl) throw new Error("OpenClaw route requires openclawUrl");
      if (!openclawToken) throw new Error("OpenClaw route requires openclawToken");
      return new OpenClawProvider({
        url: openclawUrl,
        token: openclawToken,
        clientId: clientId || "gateway-client"
      });
    }
    throw new Error(`unknown provider: ${name}`);
  }
  abort() {
    var _a;
    (_a = this.abortController) == null ? void 0 : _a.abort();
  }
  async send(userText) {
    var _a, _b;
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
        aiBeginId: null
      };
      let updated = appendTurn(md, userTurn);
      await this.vaultIO.write(this.sessionPath, updated);
      this.onEvent({ type: "user-saved", path: this.sessionPath });
      const contextBudget = Math.floor(this.tokenBudgetChars * 0.5);
      const { contextMessages } = await resolveWikilinks(userText, this.vaultIO, {
        budgetChars: contextBudget,
        onMissing: (names) => this.onEvent({ type: "reference-missing", names })
      });
      const messages = buildMessages(parseSession(updated), { tokenBudgetChars: this.tokenBudgetChars, contextMessages });
      const stream = this.provider.streamChat({
        messages,
        model: this.model,
        thinking: this.thinking,
        search: this.search,
        signal: this.abortController.signal
      });
      const { md: completed } = await this._consumeStream(stream, userTurn);
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
      if ((_b = (_a = this.abortController) == null ? void 0 : _a.signal) == null ? void 0 : _b.aborted) {
        await this._markAborted(turnId);
        this.onEvent({ type: "turn-done", path: this.sessionPath, turnId });
        return { path: this.sessionPath };
      }
      this.onEvent({ type: "error", error: err.message });
      throw err;
    } finally {
      this.abortController = null;
    }
  }
  async _consumeStream(stream, turn) {
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
    let bodyBuffer = "";
    let thinkBuffer = "";
    let searchResults = null;
    let usage = null;
    let lastFlushAt = performance.now();
    const FLUSH_INTERVAL_MS = 150;
    const FLUSH_SIZE_CHARS = 4096;
    const flush = async (force = false) => {
      const bufferedChars = bodyBuffer.length + thinkBuffer.length;
      if (!force && bufferedChars === 0) return;
      turnState.bodyBlocks = bodyBuffer ? bodyBuffer.split(/\n\n+/).map((s) => s.trim()).filter(Boolean) : [];
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
      if (result.type === "content") {
        bodyBuffer += result.delta;
        turnState.bodyBlocks = bodyBuffer ? bodyBuffer.split(/\n\n+/).map((s) => s.trim()).filter(Boolean) : [];
        this.onEvent({ type: "content-delta", delta: result.delta });
        await maybeFlush();
      } else if (result.type === "reasoning") {
        thinkBuffer += result.delta;
        turnState.thinks = thinkBuffer ? [{ elapsedSecs: null, text: thinkBuffer }] : [];
        this.onEvent({ type: "think-delta", delta: result.delta });
        await maybeFlush();
      } else if (result.type === "search_results") {
        searchResults = result.results;
        turnState.searches = [this._toSearchEntry(result.results)];
        this.onEvent({ type: "search-done", results: result.results.results });
        await flush(true);
      } else if (result.type === "finish") {
        usage = result.usage;
      }
    }
    await flush(true);
    const finalTurn = {
      ...turnState,
      meta: makeMeta({ turnId: turn.id, userTextLen: turn.userText.length, model: this.model, usage, route: this.route, peerAgent: this.peerAgent, sessionEntry: this.sessionEntry }),
      inProgress: false
    };
    return { md: prefix + serializeTurn(finalTurn) };
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
    if (!this.gatewayUrl) return;
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
  async _markAborted(turnId) {
    if (!this.sessionPath || !turnId) return;
    const md = await this.vaultIO.read(this.sessionPath);
    const marker = `<!-- turn:${turnId}`;
    const markerIdx = md.indexOf(marker);
    if (markerIdx === -1) return;
    const nextSep = md.indexOf("\n---\n", markerIdx);
    const endIdx = nextSep === -1 ? md.length : nextSep;
    const turnMd = md.slice(markerIdx, endIdx);
    let updatedTurn;
    if (turnMd.includes("<!-- ai:begin")) {
      updatedTurn = turnMd.replace(
        /(<!-- ai:begin id=\d+ -->\n[\s\S]*?)(?=\n?<!-- ai:end -->|$)/,
        `$1

> [!warning]- \u672C\u8F6E\u4E2D\u65AD
> \u7F51\u7EDC\u6216\u8FDB\u7A0B\u5F02\u5E38\uFF0C\u56DE\u590D\u672A\u5B8C\u6574\u751F\u6210\u3002`
      ) + "\n\n<!-- ai:end -->";
    } else {
      const warning = "> [!warning]- \u672C\u8F6E\u4E2D\u65AD\n> \u7F51\u7EDC\u6216\u8FDB\u7A0B\u5F02\u5E38\uFF0C\u56DE\u590D\u672A\u5B8C\u6574\u751F\u6210\u3002";
      updatedTurn = `${turnMd}

<!-- ai:begin id=${turnId} -->

${warning}

<!-- ai:end -->`;
    }
    const updated = md.slice(0, markerIdx) + updatedTurn + md.slice(endIdx);
    await this.vaultIO.write(this.sessionPath, updated);
    this.onEvent({ type: "resumed", turnId });
  }
  async resume() {
    if (!this.sessionPath) return;
    const md = await this.vaultIO.read(this.sessionPath);
    const parsed = parseSession(md);
    const inProgress = parsed.turns.find((t) => t.inProgress);
    if (!inProgress) return;
    await this._markAborted(inProgress.id);
  }
};

// src/gateway-manager.js
var import_node_child_process = require("node:child_process");
var import_node_fs = require("node:fs");
var GatewayManager = class {
  constructor({ gatewayUrl, installDir, port, autoStart = true, spawnFn = import_node_child_process.spawn }) {
    this.gatewayUrl = (gatewayUrl || `http://127.0.0.1:${port}`).replace(/\/$/, "");
    this.installDir = installDir || "";
    this.port = port || 18791;
    this.autoStart = autoStart;
    this.spawnFn = spawnFn;
    this.process = null;
    this.status = "unknown";
    this.statusMessage = "";
  }
  /** 探测 /health，返回是否就绪 */
  async probe(timeoutMs = 1500) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(`${this.gatewayUrl}/health`, { signal: controller.signal });
      if (res.ok) {
        this.status = "ready";
        this.statusMessage = "gateway \u5C31\u7EEA";
        return true;
      }
    } catch (e) {
    } finally {
      clearTimeout(timer);
    }
    return false;
  }
  /** 确保 gateway 就绪；必要时自动拉起 */
  async ensureReady() {
    if (await this.probe()) {
      return { ok: true, started: false };
    }
    if (!this.autoStart) {
      this.status = "unreachable";
      return {
        ok: false,
        error: "\u672C\u5730 gateway \u672A\u8FD0\u884C\uFF0C\u4E14\u81EA\u52A8\u62C9\u8D77\u5DF2\u5173\u95ED\u3002\u8BF7\u5728\u8BBE\u7F6E\u9875\u68C0\u67E5\u5B89\u88C5\u76EE\u5F55\uFF0C\u6216\u5207\u6362 OpenClaw \u8FDC\u7A0B\u8DEF\u7531\u3002"
      };
    }
    return this._startAndWait();
  }
  async _startAndWait() {
    this.status = "starting";
    const spawned = await this._spawnGateway();
    if (!spawned) {
      this.status = "error";
      return {
        ok: false,
        error: `\u81EA\u52A8\u62C9\u8D77\u672C\u5730 gateway \u5931\u8D25\uFF1A${this.statusMessage}\u3002\u8BF7\u68C0\u67E5\u8BBE\u7F6E\u9875\u5B89\u88C5\u76EE\u5F55\u3001\u786E\u8BA4\u5DF2\u6267\u884C cargo build --release\u3002`
      };
    }
    const ready = await this._pollReady(8e3, 300);
    if (!ready) {
      this._kill();
      this.status = "error";
      return {
        ok: false,
        error: "\u672C\u5730 gateway \u542F\u52A8\u8D85\u65F6\uFF088s\uFF09\u3002\u8BF7\u68C0\u67E5\u7AEF\u53E3\u5360\u7528\u3001\u51ED\u8BC1\u6587\u4EF6 dds-cred.txt \u662F\u5426\u5B58\u5728\uFF0C\u6216\u624B\u52A8\u8FD0\u884C gateway \u770B\u65E5\u5FD7\u3002"
      };
    }
    this.status = "ready";
    return { ok: true, started: true };
  }
  _spawnGateway() {
    return new Promise((resolve) => {
      const binary = this._binaryPath();
      if (!(0, import_node_fs.existsSync)(binary)) {
        this.statusMessage = `\u672A\u627E\u5230\u4E8C\u8FDB\u5236\uFF1A${binary}`;
        resolve(false);
        return;
      }
      const args = ["serve", "--host", "127.0.0.1", "--port", String(this.port)];
      let settled = false;
      try {
        this.process = this.spawnFn(binary, args, {
          cwd: this.installDir,
          stdio: "ignore",
          detached: false
        });
      } catch (err) {
        this.statusMessage = err.message;
        resolve(false);
        return;
      }
      this.process.on("error", (err) => {
        if (!settled) {
          settled = true;
          this.statusMessage = err.message;
          resolve(false);
        }
      });
      this.process.on("spawn", () => {
        if (!settled) {
          settled = true;
          resolve(true);
        }
      });
      this.process.on("exit", (code) => {
        if (!settled) {
          settled = true;
          this.statusMessage = `\u8FDB\u7A0B\u9000\u51FA\uFF0C\u7801 ${code != null ? code : "unknown"}`;
          resolve(false);
        } else if (this.status === "starting" || this.status === "ready") {
          this.status = "error";
          this.statusMessage = `gateway \u5F02\u5E38\u9000\u51FA\uFF0C\u7801 ${code != null ? code : "unknown"}`;
        }
      });
    });
  }
  _binaryPath() {
    const base = `${this.installDir}/target/release/deepseek-device-skill`;
    return process.platform === "win32" ? `${base}.exe` : base;
  }
  async _pollReady(totalMs, intervalMs) {
    const start = Date.now();
    while (Date.now() - start < totalMs) {
      if (await this.probe(intervalMs)) return true;
      await new Promise((r) => setTimeout(r, intervalMs));
    }
    return false;
  }
  /** 停止本管理器拉起的 gateway 进程 */
  stop() {
    this._kill();
  }
  _kill() {
    if (this.process) {
      try {
        this.process.kill();
      } catch (e) {
      }
      this.process = null;
    }
  }
  /** 人类可读的状态文本 */
  statusText() {
    const map = {
      ready: "\u7EFF\uFF1Agateway \u5C31\u7EEA",
      starting: "\u9EC4\uFF1A\u6B63\u5728\u62C9\u8D77 gateway",
      unreachable: "\u7EA2\uFF1Agateway \u4E0D\u53EF\u8FBE",
      error: `\u7EA2\uFF1A${this.statusMessage || "gateway \u5F02\u5E38"}`,
      unknown: "\u7070\uFF1A\u672A\u63A2\u6D4B"
    };
    return map[this.status] || `\u7070\uFF1A${this.status}`;
  }
};

// main.ts
var VIEW_TYPE_AI_CHAT = "ai-vault-chat-view";
var DEFAULT_SETTINGS = {
  gatewayUrl: "http://127.0.0.1:18791",
  model: "default",
  thinking: false,
  search: true,
  tokenBudgetChars: 12e3,
  defaultRoute: "local",
  openclawUrl: "http://100.69.11.71:18789",
  openclawToken: "",
  clientId: "gateway-client",
  peerAgent: "main",
  sessionEntry: "note",
  gatewayInstallDir: "C:/Users/22414/dev/deepseek-device-skill",
  gatewayAutoStart: true
};
function modelToGatewayModel(model, route) {
  if (route === "openclaw") {
    return model === "expert" ? "openclaw/main" : "openclaw/default";
  }
  return model === "expert" ? "deepseek-reasoner" : "deepseek-chat";
}
function peerAgentToHeaderId(peerAgent) {
  return peerAgent === "device" ? "device" : "gray";
}
function peerAgentDisplay(peerAgent) {
  return peerAgent === "device" ? "device" : "\u683C\u96F7";
}
function sessionEntryDisplay(entry) {
  return entry === "main" ? "\u4E3B\u4F1A\u8BDD" : "\u7B14\u8BB0\u4F1A\u8BDD";
}
function routeToProvider(route) {
  return route === "openclaw" ? "openclaw" : "openai-compat";
}
function urlToPort(url, fallback) {
  try {
    const u = new URL(url);
    return parseInt(u.port, 10) || fallback;
  } catch (e) {
    return fallback;
  }
}
function makeVaultIO(adapter) {
  return {
    read: async (path) => {
      const exists = await adapter.exists(path);
      if (!exists) return "";
      return adapter.read(path);
    },
    write: async (path, text) => {
      await adapter.write(path, text);
    },
    append: async (path, text) => {
      const existing = await adapter.exists(path) ? await adapter.read(path) : "";
      await adapter.write(path, existing + text);
    },
    exists: async (path) => adapter.exists(path),
    rename: async (oldPath, newPath) => {
      await adapter.rename(oldPath, newPath);
    },
    mkdir: async (path) => {
      if (!await adapter.exists(path)) {
        await adapter.mkdir(path);
      }
    }
  };
}
var AiVaultChatView = class extends import_obsidian.ItemView {
  constructor(leaf, plugin) {
    super(leaf);
    this.engine = null;
    this.currentPath = null;
    this.isStreaming = false;
    this.renderTimer = null;
    this.plugin = plugin;
    this.currentRoute = plugin.settings.defaultRoute;
    this.currentSessionEntry = plugin.settings.sessionEntry;
  }
  getViewType() {
    return VIEW_TYPE_AI_CHAT;
  }
  getDisplayText() {
    return "AI \u4F1A\u8BDD";
  }
  getIcon() {
    return "message-square";
  }
  async onOpen() {
    this.rootEl = this.contentEl.createDiv({ cls: "ai-vault-chat-container" });
    this.renderLayout();
    await this.loadSessionList();
    this.registerEvent(this.app.vault.on("create", (file) => this.onVaultChange(file)));
    this.registerEvent(this.app.vault.on("delete", (file) => this.onVaultChange(file)));
    this.registerEvent(this.app.vault.on("rename", (file) => this.onVaultChange(file)));
  }
  onVaultChange(file) {
    if (file instanceof import_obsidian.TFile && file.path.startsWith("AI \u4F1A\u8BDD/")) {
      this.loadSessionList();
    }
  }
  renderLayout() {
    this.rootEl.empty();
    this.identityHeaderEl = this.rootEl.createEl("div", {
      cls: "ai-vault-chat-identity",
      text: this.identityText()
    });
    const toolbar = this.rootEl.createDiv({ cls: "ai-vault-chat-toolbar" });
    toolbar.createEl("button", { text: "\u65B0\u4F1A\u8BDD", cls: "ai-vault-chat-btn" }, (btn) => {
      btn.addEventListener("click", () => this.newSession());
    });
    toolbar.createEl("button", { text: "\u7EE7\u7EED\u5F53\u524D", cls: "ai-vault-chat-btn" }, (btn) => {
      btn.addEventListener("click", () => this.resumeCurrent());
    });
    toolbar.createEl("button", { text: "\u63D2\u5165\u5F15\u7528", cls: "ai-vault-chat-btn" }, (btn) => {
      this.insertRefBtnEl = btn;
      btn.addEventListener("click", () => this.insertCurrentNoteReference());
    });
    toolbar.createEl("div", { cls: "ai-vault-chat-route" }, (routeWrap) => {
      routeWrap.createEl("span", { text: "\u8DEF\u7531\uFF1A", cls: "ai-vault-chat-route-label" });
      this.routeSelectEl = routeWrap.createEl("select", { cls: "ai-vault-chat-route-select" });
      this.routeSelectEl.createEl("option", { text: "\u672C\u5730", value: "local" });
      this.routeSelectEl.createEl("option", { text: "OpenClaw", value: "openclaw" });
      this.routeSelectEl.value = this.currentRoute;
      this.routeSelectEl.addEventListener("change", () => this.onRouteChange());
      this.routeBadgeEl = routeWrap.createEl("span", {
        cls: "ai-vault-chat-route-badge",
        text: this.routeBadgeText(this.currentRoute)
      });
    });
    toolbar.createEl("div", { cls: "ai-vault-chat-route" }, (entryWrap) => {
      entryWrap.createEl("span", { text: "\u5165\u53E3\uFF1A", cls: "ai-vault-chat-route-label" });
      this.sessionEntrySelectEl = entryWrap.createEl("select", { cls: "ai-vault-chat-route-select" });
      this.sessionEntrySelectEl.createEl("option", { text: "\u7B14\u8BB0\u4F1A\u8BDD", value: "note" });
      this.sessionEntrySelectEl.createEl("option", { text: "\u4E3B\u4F1A\u8BDD\u6302\u63A5", value: "main" });
      this.sessionEntrySelectEl.value = this.currentSessionEntry;
      this.sessionEntrySelectEl.disabled = this.currentRoute !== "openclaw";
      this.sessionEntrySelectEl.addEventListener("change", () => this.onSessionEntryChange());
    });
    this.sessionListEl = this.rootEl.createDiv({ cls: "ai-vault-chat-sessions" });
    this.messagesEl = this.rootEl.createDiv({ cls: "ai-vault-chat-messages" });
    const inputArea = this.rootEl.createDiv({ cls: "ai-vault-chat-input-area" });
    this.inputEl = inputArea.createEl("textarea", {
      cls: "ai-vault-chat-input",
      attr: { placeholder: "\u8F93\u5165\u6D88\u606F\u2026", rows: "3" }
    });
    this.sendBtnEl = inputArea.createEl("button", {
      text: "\u53D1\u9001",
      cls: "ai-vault-chat-send-btn"
    });
    this.sendBtnEl.addEventListener("click", () => this.onSend());
    this.inputEl.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        this.onSend();
      }
    });
    this.statusEl = this.rootEl.createDiv({ cls: "ai-vault-chat-status" });
  }
  async loadSessionList() {
    this.sessionListEl.empty();
    const files = this.app.vault.getFiles().filter((f) => f.path.startsWith("AI \u4F1A\u8BDD/") && f.extension === "md").sort((a, b) => b.stat.mtime - a.stat.mtime);
    if (files.length === 0) {
      this.sessionListEl.createEl("div", { text: "\u6682\u65E0\u4F1A\u8BDD", cls: "ai-vault-chat-empty" });
      return;
    }
    for (const file of files.slice(0, 20)) {
      const btn = this.sessionListEl.createEl("button", {
        text: file.basename,
        cls: "ai-vault-chat-session-item"
      });
      btn.addEventListener("click", () => this.loadSession(file.path));
      if (file.path === this.currentPath) {
        btn.addClass("ai-vault-chat-session-active");
      }
    }
  }
  async loadSession(path) {
    this.currentPath = path;
    await this.loadSessionList();
    this.engine = this.createEngine(path);
    await this.renderMessages();
  }
  newSession() {
    this.currentPath = null;
    this.engine = null;
    this.currentSessionEntry = this.plugin.settings.sessionEntry;
    this.sessionEntrySelectEl.value = this.currentSessionEntry;
    this.updateIdentityHeader();
    this.messagesEl.empty();
    this.setStatus("\u65B0\u4F1A\u8BDD\uFF1A\u8F93\u5165\u7B2C\u4E00\u6761\u6D88\u606F");
  }
  async resumeCurrent() {
    if (!this.currentPath || !this.engine) {
      new import_obsidian.Notice("\u6CA1\u6709\u53EF\u7EE7\u7EED\u7684\u4F1A\u8BDD");
      return;
    }
    this.setStatus("\u5904\u7406\u4E2D\u65AD\u2026");
    await this.engine.resume();
    await this.renderMessages();
    this.setStatus("\u5DF2\u6807\u8BB0\u4E2D\u65AD");
  }
  routeBadgeText(route) {
    return route === "openclaw" ? "\u8FDC\u7A0B" : "\u672C\u5730";
  }
  identityText() {
    if (this.currentRoute !== "openclaw") return "\u672C\u5730";
    const peer = peerAgentDisplay(this.plugin.settings.peerAgent);
    const entry = sessionEntryDisplay(this.currentSessionEntry);
    return `\u8FDC\u7A0B \xB7 ${peer} \xB7 ${entry}`;
  }
  updateIdentityHeader() {
    if (this.identityHeaderEl) {
      this.identityHeaderEl.textContent = this.identityText();
    }
  }
  onRouteChange() {
    const route = this.routeSelectEl.value;
    if (route === this.currentRoute) return;
    this.currentRoute = route;
    this.routeBadgeEl.textContent = this.routeBadgeText(route);
    this.sessionEntrySelectEl.disabled = route !== "openclaw";
    if (route === "local") {
      this.currentSessionEntry = "note";
      this.sessionEntrySelectEl.value = "note";
    }
    this.updateIdentityHeader();
    if (!this.isStreaming) {
      this.engine = null;
    }
    this.setStatus(`\u5DF2\u5207\u6362\u5230 ${this.routeBadgeText(route)} \u8DEF\u7531`);
  }
  onSessionEntryChange() {
    const entry = this.sessionEntrySelectEl.value;
    if (entry === this.currentSessionEntry) return;
    this.currentSessionEntry = entry;
    this.updateIdentityHeader();
    if (!this.isStreaming) {
      this.engine = null;
    }
    this.setStatus(`\u5DF2\u5207\u6362\u5230 ${sessionEntryDisplay(entry)}`);
  }
  createEngine(sessionPath) {
    const vaultIO = makeVaultIO(this.app.vault.adapter);
    const route = this.currentRoute;
    if (route === "openclaw") {
      if (!this.plugin.settings.openclawUrl || !this.plugin.settings.openclawToken) {
        throw new Error("OpenClaw \u8DEF\u7531\u9700\u8981\u5148\u5728\u8BBE\u7F6E\u4E2D\u586B\u5199 URL \u548C Token");
      }
    }
    const settings = this.plugin.settings;
    const model = modelToGatewayModel(settings.model, route);
    const tokenBudgetChars = route === "openclaw" ? 48e3 : settings.tokenBudgetChars;
    const peerAgent = route === "openclaw" ? settings.peerAgent : "main";
    const sessionEntry = route === "openclaw" ? this.currentSessionEntry : "note";
    const engine = new SessionEngine({
      gatewayUrl: settings.gatewayUrl,
      model,
      thinking: settings.thinking,
      search: settings.search,
      vaultIO,
      tokenBudgetChars,
      provider: routeToProvider(route),
      route,
      openclawUrl: settings.openclawUrl,
      openclawToken: settings.openclawToken,
      clientId: settings.clientId,
      sessionEntry,
      peerAgent,
      agentId: peerAgentToHeaderId(peerAgent),
      onEvent: (e) => {
        if (e.type === "user-saved") {
          this.currentPath = e.path || null;
          this.loadSessionList();
          this.renderMessages();
        } else if (e.type === "content-delta" || e.type === "think-delta") {
          this.debouncedRender();
        } else if (e.type === "search-done") {
          this.debouncedRender();
        } else if (e.type === "turn-done") {
          this.isStreaming = false;
          this.setInputEnabled(true);
          this.setStatus("");
          this.renderMessages();
          this.loadSessionList();
        } else if (e.type === "reference-missing") {
          const names = e.names || [];
          new import_obsidian.Notice(`\u5F15\u7528\u7B14\u8BB0\u672A\u627E\u5230\uFF1A${names.join("\u3001")}\uFF0C\u5C06\u6309\u7EAF\u6587\u672C\u53D1\u9001`);
        } else if (e.type === "error") {
          this.isStreaming = false;
          this.setInputEnabled(true);
          this.setStatus(`\u9519\u8BEF\uFF1A${e.error}`);
          new import_obsidian.Notice(`AI \u4F1A\u8BDD\u9519\u8BEF\uFF1A${e.error}`);
        }
      }
    });
    if (sessionPath) {
      engine.sessionPath = sessionPath;
    }
    return engine;
  }
  debouncedRender() {
    if (this.renderTimer) window.clearTimeout(this.renderTimer);
    this.renderTimer = window.setTimeout(() => this.renderMessages(), 150);
  }
  async renderMessages() {
    this.messagesEl.empty();
    if (!this.currentPath) return;
    const text = await this.app.vault.adapter.read(this.currentPath);
    await import_obsidian.MarkdownRenderer.render(this.app, text, this.messagesEl, this.currentPath, this);
  }
  async onSend() {
    const text = this.inputEl.value.trim();
    if (!text) return;
    if (this.isStreaming) return;
    const userText = text;
    this.isStreaming = true;
    this.setInputEnabled(false);
    this.inputEl.value = "";
    this.setStatus("\u51C6\u5907 gateway\u2026");
    try {
      if (this.currentRoute === "local") {
        const ready = await this.plugin.gatewayManager.ensureReady();
        if (!ready.ok) {
          throw new Error(ready.error || "\u672C\u5730 gateway \u672A\u5C31\u7EEA");
        }
        if (ready.started) {
          this.setStatus("gateway \u5DF2\u81EA\u52A8\u62C9\u8D77\uFF0C\u53D1\u9001\u4E2D\u2026");
        }
      }
      if (!this.engine) {
        this.engine = this.createEngine(null);
      }
      await this.engine.send(userText);
    } catch (err) {
      this.isStreaming = false;
      this.setInputEnabled(true);
      this.setStatus(`\u9519\u8BEF\uFF1A${err.message}`);
      new import_obsidian.Notice(`\u53D1\u9001\u5931\u8D25\uFF1A${err.message}`);
    }
  }
  insertCurrentNoteReference() {
    var _a, _b;
    const active = this.app.workspace.getActiveFile();
    if (!active || active.extension !== "md") {
      new import_obsidian.Notice("\u5F53\u524D\u6CA1\u6709\u6253\u5F00\u7684\u7B14\u8BB0\u53EF\u5F15\u7528");
      return;
    }
    const link = `[[${active.basename}]]`;
    const input = this.inputEl;
    const start = (_a = input.selectionStart) != null ? _a : input.value.length;
    const end = (_b = input.selectionEnd) != null ? _b : input.value.length;
    const before = input.value.slice(0, start);
    const after = input.value.slice(end);
    const spacer = before.length > 0 && !before.endsWith(" ") ? " " : "";
    input.value = `${before}${spacer}${link} ${after}`;
    const cursorPos = start + spacer.length + link.length + 1;
    input.setSelectionRange(cursorPos, cursorPos);
    input.focus();
  }
  setInputEnabled(enabled) {
    this.inputEl.disabled = !enabled;
    this.sendBtnEl.disabled = !enabled;
    this.sendBtnEl.textContent = enabled ? "\u53D1\u9001" : "\u751F\u6210\u4E2D\u2026";
    if (this.insertRefBtnEl) this.insertRefBtnEl.disabled = !enabled;
  }
  setStatus(text) {
    this.statusEl.textContent = text;
  }
};
var AiVaultChatSettingTab = class extends import_obsidian.PluginSettingTab {
  constructor(app, plugin) {
    super(app, plugin);
    this.plugin = plugin;
  }
  display() {
    const { containerEl } = this;
    containerEl.empty();
    containerEl.createEl("h2", { text: "AI Vault Chat \u8BBE\u7F6E" });
    new import_obsidian.Setting(containerEl).setName("Gateway URL").setDesc("\u672C\u5730 deepseek-device-skill \u670D\u52A1\u5730\u5740\uFF08\u672C\u5730\u8DEF\u7531\u4F7F\u7528\uFF09").addText(
      (text) => text.setPlaceholder("http://127.0.0.1:18791").setValue(this.plugin.settings.gatewayUrl).onChange(async (value) => {
        this.plugin.settings.gatewayUrl = value;
        this.plugin.gatewayManager = new GatewayManager({
          gatewayUrl: value,
          installDir: this.plugin.settings.gatewayInstallDir,
          port: urlToPort(value, 18791),
          autoStart: this.plugin.settings.gatewayAutoStart
        });
        await this.plugin.saveSettings();
      })
    );
    containerEl.createEl("h3", { text: "\u672C\u5730 gateway" });
    containerEl.createEl("p", {
      text: "\u63D2\u4EF6\u5728\u672C\u5730\u8DEF\u7531\u53D1\u9001\u524D\u81EA\u52A8\u63A2\u6D4B\u5E76\u62C9\u8D77 deepseek-device-skill serve\uFF1B\u5378\u8F7D\u63D2\u4EF6\u65F6\u4F1A\u81EA\u52A8\u5173\u95ED\u81EA\u5DF1\u62C9\u8D77\u7684\u8FDB\u7A0B\u3002",
      cls: "setting-item-description"
    });
    new import_obsidian.Setting(containerEl).setName("\u5B89\u88C5\u76EE\u5F55").setDesc("deepseek-device-skill \u4ED3\u5E93\u6839\u76EE\u5F55\uFF1B\u9700\u8981\u5305\u542B target/release/deepseek-device-skill.exe\uFF0C\u4E14\u76EE\u5F55\u4E0B\u6709 dds-cred.txt\u3002").addText(
      (text) => text.setPlaceholder("C:/Users/22414/dev/deepseek-device-skill").setValue(this.plugin.settings.gatewayInstallDir).onChange(async (value) => {
        this.plugin.settings.gatewayInstallDir = value;
        this.plugin.gatewayManager = new GatewayManager({
          gatewayUrl: this.plugin.settings.gatewayUrl,
          installDir: value,
          port: urlToPort(this.plugin.settings.gatewayUrl, 18791),
          autoStart: this.plugin.settings.gatewayAutoStart
        });
        await this.plugin.saveSettings();
      })
    );
    const statusSetting = new import_obsidian.Setting(containerEl).setName("\u72B6\u6001").setDesc("\u70B9\u51FB\u5237\u65B0");
    const statusEl = statusSetting.controlEl.createEl("span", {
      text: this.plugin.gatewayManager.statusText(),
      cls: "ai-vault-gateway-status"
    });
    statusSetting.addButton(
      (btn) => btn.setButtonText("\u5237\u65B0").onClick(async () => {
        await this.plugin.gatewayManager.probe();
        statusEl.textContent = this.plugin.gatewayManager.statusText();
      })
    );
    new import_obsidian.Setting(containerEl).setName("\u968F\u63D2\u4EF6\u81EA\u52A8\u62C9\u8D77").setDesc("\u5173\u95ED\u540E\uFF0Cgateway \u4E0D\u53EF\u8FBE\u65F6\u5C06\u4E0D\u518D\u81EA\u52A8\u542F\u52A8\uFF0C\u9700\u624B\u52A8\u8FD0\u884C\u3002").addToggle(
      (t) => t.setValue(this.plugin.settings.gatewayAutoStart).onChange(async (value) => {
        this.plugin.settings.gatewayAutoStart = value;
        this.plugin.gatewayManager = new GatewayManager({
          gatewayUrl: this.plugin.settings.gatewayUrl,
          installDir: this.plugin.settings.gatewayInstallDir,
          port: urlToPort(this.plugin.settings.gatewayUrl, 18791),
          autoStart: value
        });
        await this.plugin.saveSettings();
      })
    );
    containerEl.createEl("h3", { text: "\u6A21\u578B\u8DEF\u7531" });
    containerEl.createEl("p", {
      text: "\u9009\u62E9\u672C\u4F1A\u8BDD\u7684\u6A21\u578B\u63D0\u4F9B\u5546\u3002\u672C\u5730 = \u5185\u5D4C/\u672C\u673A DeepSeek gateway\uFF1B\u8FDC\u7A0B = OpenClaw HTTP \u7AEF\u70B9\uFF08shared-secret token\uFF0C\u65E0\u9700\u914D\u5BF9\uFF09\u3002",
      cls: "setting-item-description"
    });
    new import_obsidian.Setting(containerEl).setName("\u9ED8\u8BA4\u8DEF\u7531").setDesc("\u65B0\u5EFA\u4F1A\u8BDD\u7684\u9ED8\u8BA4\u8DEF\u7531").addDropdown(
      (drop) => drop.addOption("local", "\u672C\u5730\uFF08\u5185\u5D4C DeepSeek gateway\uFF09").addOption("openclaw", "OpenClaw\uFF08\u8FDC\u7A0B agent\uFF09").setValue(this.plugin.settings.defaultRoute).onChange(async (value) => {
        this.plugin.settings.defaultRoute = value;
        await this.plugin.saveSettings();
      })
    );
    new import_obsidian.Setting(containerEl).setName("OpenClaw URL").setDesc("OpenClaw HTTP root URL\uFF08\u4F8B\u5982 http://100.69.11.71:18789\uFF0C\u4E0D\u542B /v1\uFF09").addText(
      (text) => text.setPlaceholder("http://100.69.11.71:18789/v1").setValue(this.plugin.settings.openclawUrl).onChange(async (value) => {
        this.plugin.settings.openclawUrl = value;
        await this.plugin.saveSettings();
      })
    );
    new import_obsidian.Setting(containerEl).setName("OpenClaw Token").setDesc("shared-secret bearer token\uFF08\u4ECE claw-cred.txt \u83B7\u53D6\uFF0C\u4EC5\u4FDD\u5B58\u5728\u63D2\u4EF6 data.json\uFF09").addText((text) => {
      text.inputEl.type = "password";
      text.setPlaceholder("").setValue(this.plugin.settings.openclawToken).onChange(async (value) => {
        this.plugin.settings.openclawToken = value;
        await this.plugin.saveSettings();
      });
    });
    new import_obsidian.Setting(containerEl).setName("OpenClaw Client ID").setDesc("\u4FDD\u7559\u5B57\u6BB5\uFF0C\u5F53\u524D HTTP \u9762\u4E0D\u4F7F\u7528").addText(
      (text) => text.setPlaceholder("gateway-client").setValue(this.plugin.settings.clientId).onChange(async (value) => {
        this.plugin.settings.clientId = value;
        await this.plugin.saveSettings();
      })
    );
    new import_obsidian.Setting(containerEl).setName("\u5BF9\u4FA7\u4EE3\u7406").setDesc("\u4EC5 OpenClaw \u8DEF\u7531\u751F\u6548\u3002main = \u683C\u96F7\uFF1Bdevice = device \u8EAB\u4EFD\u3002").addDropdown(
      (drop) => drop.addOption("main", "main\uFF08\u683C\u96F7\uFF09").addOption("device", "device").setValue(this.plugin.settings.peerAgent).onChange(async (value) => {
        this.plugin.settings.peerAgent = value;
        await this.plugin.saveSettings();
      })
    );
    new import_obsidian.Setting(containerEl).setName("\u9ED8\u8BA4\u4F1A\u8BDD\u5165\u53E3").setDesc("\u4EC5 OpenClaw \u8DEF\u7531\u751F\u6548\u3002\u7B14\u8BB0\u4F1A\u8BDD = \u6BCF\u4E2A md \u9694\u79BB\uFF1B\u4E3B\u4F1A\u8BDD\u6302\u63A5 = \u4E0E Kimi \u5BA2\u6237\u7AEF\u5171\u4EAB\u683C\u96F7\u4E3B\u4F1A\u8BDD\u3002").addDropdown(
      (drop) => drop.addOption("note", "\u7B14\u8BB0\u4F1A\u8BDD\uFF08\u9694\u79BB\uFF09").addOption("main", "\u4E3B\u4F1A\u8BDD\u6302\u63A5\uFF08\u4E0E Kimi \u5BA2\u6237\u7AEF\u5171\u4EAB\uFF09").setValue(this.plugin.settings.sessionEntry).onChange(async (value) => {
        this.plugin.settings.sessionEntry = value;
        await this.plugin.saveSettings();
      })
    );
    new import_obsidian.Setting(containerEl).setName("\u6A21\u578B").setDesc("\u672C\u5730\uFF1Adefault=deepseek-chat / expert=deepseek-reasoner\uFF1BOpenClaw\uFF1Adefault=openclaw/default / expert=openclaw/main").addDropdown(
      (drop) => drop.addOption("default", "default").addOption("expert", "expert").setValue(this.plugin.settings.model).onChange(async (value) => {
        this.plugin.settings.model = value;
        await this.plugin.saveSettings();
      })
    );
    new import_obsidian.Setting(containerEl).setName("Thinking").setDesc("\u662F\u5426\u8F93\u51FA\u601D\u8003\u94FE").addToggle(
      (t) => t.setValue(this.plugin.settings.thinking).onChange(async (value) => {
        this.plugin.settings.thinking = value;
        await this.plugin.saveSettings();
      })
    );
    new import_obsidian.Setting(containerEl).setName("Search").setDesc("\u662F\u5426\u542F\u7528\u8054\u7F51\u641C\u7D22").addToggle(
      (t) => t.setValue(this.plugin.settings.search).onChange(async (value) => {
        this.plugin.settings.search = value;
        await this.plugin.saveSettings();
      })
    );
    new import_obsidian.Setting(containerEl).setName("Token \u9884\u7B97\uFF08\u5B57\u7B26\uFF09").setDesc("\u8D85\u51FA\u540E\u81EA\u52A8\u538B\u7F29\u5386\u53F2\u4F1A\u8BDD").addText(
      (text) => text.setPlaceholder("12000").setValue(String(this.plugin.settings.tokenBudgetChars)).onChange(async (value) => {
        const n = parseInt(value, 10);
        if (!isNaN(n) && n > 0) {
          this.plugin.settings.tokenBudgetChars = n;
          await this.plugin.saveSettings();
        }
      })
    );
  }
};
var AiVaultChatPlugin = class extends import_obsidian.Plugin {
  async onload() {
    await this.loadSettings();
    this.gatewayManager = new GatewayManager({
      gatewayUrl: this.settings.gatewayUrl,
      installDir: this.settings.gatewayInstallDir,
      port: urlToPort(this.settings.gatewayUrl, 18791),
      autoStart: this.settings.gatewayAutoStart
    });
    this.registerView(VIEW_TYPE_AI_CHAT, (leaf) => new AiVaultChatView(leaf, this));
    this.addRibbonIcon("message-square", "AI Vault Chat", () => {
      this.activateView();
    });
    this.addCommand({
      id: "open-ai-vault-chat",
      name: "\u6253\u5F00 AI Vault Chat",
      callback: () => this.activateView()
    });
    this.addSettingTab(new AiVaultChatSettingTab(this.app, this));
  }
  onunload() {
    var _a;
    this.app.workspace.detachLeavesOfType(VIEW_TYPE_AI_CHAT);
    (_a = this.gatewayManager) == null ? void 0 : _a.stop();
  }
  async loadSettings() {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
  }
  async saveSettings() {
    await this.saveData(this.settings);
  }
  async activateView() {
    const { workspace } = this.app;
    let leaf = workspace.getRightLeaf(false);
    if (!leaf) {
      leaf = workspace.getLeaf("split", "vertical");
    }
    await leaf.setViewState({ type: VIEW_TYPE_AI_CHAT, active: true });
    workspace.revealLeaf(leaf);
  }
};
