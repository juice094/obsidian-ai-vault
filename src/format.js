// AI 会话 md 格式解析器/序列化器（v1）
// 零依赖，Node 18+/浏览器通用 ESM。

const FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---\r?\n/;
const TURN_META_RE = /<!--\s*turn:(\d+)\s+([^>]+?)\s*-->/;
const SUMMARY_RE = /<!--\s*summary\s+covers=(\d+)\s*-->/;
const AI_BEGIN_RE = /<!--\s*ai:begin\s+id=(\d+)\s*-->/;
const AI_END_RE = /<!--\s*ai:end\s*-->/;

function trimLines(lines) {
  while (lines.length && lines[0].trim() === '') lines.shift();
  while (lines.length && lines[lines.length - 1].trim() === '') lines.pop();
  return lines;
}

function parseFrontmatter(text) {
  const m = text.match(FRONTMATTER_RE);
  if (!m) return { frontmatter: {}, body: text };
  const fm = {};
  for (const line of m[1].split('\n')) {
    const idx = line.indexOf(':');
    if (idx === -1) continue;
    const key = line.slice(0, idx).trim();
    let value = line.slice(idx + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))) {
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
    if (!line.trim().startsWith('>')) break;
    contentLines.push(line.replace(/^>\s?/, ''));
    i++;
  }
  return {
    type,
    toggle,
    title: titleLine.trim(),
    content: contentLines.join('\n').trim(),
    endIdx: i,
  };
}

function parseSearchCallout(title, content) {
  // title: 已阅读 N 个网页 · "查询词"
  const titleMatch = title.match(/已阅读\s+(\d+)\s+个网页\s+·\s+"([^"]+)"/);
  const queries = titleMatch ? [titleMatch[2]] : [];
  const results = [];
  const lines = content.split('\n');
  for (const line of lines) {
    const m = line.match(/^(\d+)\.\s*\[([^\]]+)\]\(([^)]+)\)\s*—\s*([^\n]+)/);
    if (m) {
      results.push({
        index: parseInt(m[1], 10),
        title: m[2],
        url: m[3],
        site: m[4].trim(),
      });
    }
  }
  return { queries, results };
}

function parseThinkCallout(title, content) {
  const m = title.match(/已思考\s+·\s+(\d+)\s*秒/);
  return {
    elapsedSecs: m ? parseInt(m[1], 10) : null,
    text: content.trim(),
  };
}

function parseSummaryCallout(title, content) {
  const m = title.match(/前情摘要\s*（覆盖至第\s*(\d+)\s*轮\s*）/);
  return {
    coversTurn: m ? parseInt(m[1], 10) : null,
    text: content.trim(),
  };
}

function parseTurn(sectionText) {
  const lines = sectionText.split('\n');
  let i = 0;
  let meta = null;
  let turnId = null;
  const turnMetaMatch = lines[i]?.match(TURN_META_RE);
  if (turnMetaMatch) {
    turnId = parseInt(turnMetaMatch[1], 10);
    meta = {};
    for (const kv of turnMetaMatch[2].trim().split(/\s+/)) {
      const [k, v] = kv.split('=');
      if (k && v) meta[k] = v;
    }
    i++;
  }

  let userText = '';
  const thinks = [];
  const searches = [];
  let bodyStart = -1;
  let bodyEnd = -1;
  let aiBeginId = null;

  while (i < lines.length) {
    const line = lines[i];
    if (line.trim().startsWith('>')) {
      const callout = parseCallout(lines, i);
      if (!callout) { i++; continue; }
      i = callout.endIdx;
      if (callout.type === 'user') {
        userText = callout.content;
      } else if (callout.type === 'think') {
        thinks.push(parseThinkCallout(callout.title, callout.content));
      } else if (callout.type === 'search') {
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
    const raw = lines.slice(bodyStart + 1, endLine).join('\n').trim();
    if (raw) bodyBlocks.push(...raw.split(/\n\n+/).map(s => s.trim()).filter(Boolean));
  }

  return {
    id: turnId,
    userText,
    thinks,
    searches,
    bodyBlocks,
    meta,
    inProgress,
    aiBeginId,
  };
}

export function parseSession(mdText) {
  const { frontmatter, body } = parseFrontmatter(mdText);
  const sections = body.split(/\r?\n---\r?\n/).map(s => s.trim()).filter(Boolean);

  let summary = null;
  const turns = [];

  for (const section of sections) {
    const lines = section.split('\n');
    const summaryMatch = section.match(SUMMARY_RE);
    if (summaryMatch) {
      // 摘要区：第一行 summary 注释，接下来是 summary callout
      for (let i = 0; i < lines.length; i++) {
        if (lines[i].trim().startsWith('>')) {
          const callout = parseCallout(lines, i);
          if (callout && callout.type === 'summary') {
            const parsed = parseSummaryCallout(callout.title, callout.content);
            summary = {
              coversTurn: parseInt(summaryMatch[1], 10),
              text: parsed.text,
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
  const lines = content ? content.split('\n') : [];
  const body = lines.map(l => `> ${l}`).join('\n');
  const heading = title ? `> ${marker} ${title}` : `> ${marker}`;
  if (!body) return heading;
  return `${heading}\n${body}`;
}

export function serializeTurn(turn) {
  const parts = [];
  if (turn.id !== null && turn.meta) {
    const metaPairs = Object.entries(turn.meta)
      .map(([k, v]) => `${k}=${v}`)
      .join(' ');
    parts.push(`<!-- turn:${turn.id} ${metaPairs} -->`);
  }
  if (turn.userText) {
    parts.push(serializeCallout('user', '', '你', turn.userText));
  }
  for (const search of turn.searches) {
    const resultLines = search.results.map((r, idx) =>
      `${idx + 1}. [${r.title}](${r.url}) — ${r.site}`
    );
    const query = search.queries[0] || '';
    const title = `已阅读 ${search.results.length} 个网页 · "${query}"`;
    parts.push(serializeCallout('search', '-', title, resultLines.join('\n')));
  }
  for (const think of turn.thinks) {
    const secs = think.elapsedSecs ?? 'N';
    const title = `已思考 · ${secs} 秒`;
    parts.push(serializeCallout('think', '-', title, think.text));
  }
  if (turn.bodyBlocks.length) {
    parts.push(`<!-- ai:begin id=${turn.aiBeginId ?? turn.id ?? ''} -->`);
    parts.push(turn.bodyBlocks.join('\n\n'));
    if (!turn.inProgress) {
      parts.push('<!-- ai:end -->');
    }
  }
  return parts.join('\n\n');
}

export function appendTurn(mdText, turn) {
  const serialized = serializeTurn(turn);
  if (!serialized) return mdText;
  const trimmed = mdText.trimEnd();
  if (trimmed === '') return serialized;
  // 若已有内容，先补分隔线再追加
  if (trimmed.endsWith('---')) {
    return `${trimmed}\n\n${serialized}`;
  }
  return `${trimmed}\n\n---\n\n${serialized}`;
}

export function writeSummary(mdText, coversTurn, summaryText) {
  const { frontmatter, body } = parseFrontmatter(mdText);
  const summaryBlock = `<!-- summary covers=${coversTurn} -->\n\n${serializeCallout('summary', '+', `前情摘要（覆盖至第 ${coversTurn} 轮）`, summaryText)}`;
  if (!body.trim()) {
    return frontmatterText(frontmatter) + summaryBlock;
  }
  // 移除旧 summary（如果存在）
  const cleaned = body.replace(/<!--\s*summary\s+covers=\d+\s*-->\r?\n[\s\S]*?(?=\r?\n---\r?\n|$)/, '').trim();
  return frontmatterText(frontmatter) + summaryBlock + '\n\n---\n\n' + cleaned;
}

function frontmatterText(frontmatter) {
  const entries = Object.entries(frontmatter);
  if (!entries.length) return '';
  const lines = entries.map(([k, v]) => `${k}: ${v}`);
  return `---\n${lines.join('\n')}\n---\n\n`;
}

export function buildMessages(parsed, { tokenBudgetChars }) {
  const messages = [];
  const budget = tokenBudgetChars ?? Infinity;

  const includedTurns = parsed.turns.filter(t => !t.inProgress);

  // 若存在 summary，先加入；轮次从 coversTurn 之后开始算
  const startTurn = parsed.summary ? parsed.summary.coversTurn : 0;
  if (parsed.summary) {
    messages.push({ role: 'user', content: `前情摘要：${parsed.summary.text}` });
  }

  // 按轮次组装成对消息，便于整轮丢弃
  const turnPairs = [];
  for (const turn of includedTurns) {
    if (turn.id !== null && turn.id <= startTurn) continue;
    const pair = [];
    if (turn.userText) {
      pair.push({ role: 'user', content: turn.userText });
    }
    const body = turn.bodyBlocks.join('\n\n');
    if (body) {
      pair.push({ role: 'assistant', content: body });
    }
    if (pair.length) turnPairs.push(pair);
  }

  // 预算裁剪：丢最旧轮次（summary 保留）
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
