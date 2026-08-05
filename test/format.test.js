import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { parseSession, serializeTurn, appendTurn, writeSummary, buildMessages, extractWikilinks, resolveWikilinks } from '../src/format.js';

const sampleMd = `---
chat_format: 1
session_id: 8f3a2c01-demo
model: expert
thinking: true
search: true
created: 2026-07-28T14:00:11+08:00
---

<!-- summary covers=6 -->
> [!summary]+ 前情摘要（覆盖至第 6 轮）
> 用户在调研把 AI 会话存入 Obsidian vault 的方案，已确定用
> callout 承载思考/搜索段、正文裸写。

---

<!-- turn:7 user_msg=41 ai_msg=42 model=expert route=local tokens=1832 time=2026-07-28T14:03:22+08:00 -->
> [!user]
> 搜索一下 syncthing 冲突文件的最新处理方案，给我一个对比

> [!search]- 已阅读 2 个网页 · "syncthing conflict resolution"
> 1. [Syncthing Docs — Syncing](https://docs.syncthing.net/users/syncing.html) — docs.syncthing.net
>    官方文档关于冲突副本的说明
> 2. [Forum: how conflicts work](https://forum.syncthing.net/) — forum.syncthing.net
>    社区讨论

> [!think]- 已思考 · 41 秒
> 用户在问冲突文件处理，需要区分简单场景和分叉版本向量……

<!-- ai:begin id=42 -->
目前 Syncthing 的冲突处理有两条路线 [1]：

1. **冲突副本**：检测到并发修改时保留两份。
2. **版本向量仲裁**：……

推荐的做法是……
<!-- ai:end -->

---
`;

describe('parseSession', () => {
  it('parses the full sample fixture', () => {
    const parsed = parseSession(sampleMd);

    assert.deepEqual(parsed.frontmatter, {
      chat_format: '1',
      session_id: '8f3a2c01-demo',
      model: 'expert',
      thinking: 'true',
      search: 'true',
      created: '2026-07-28T14:00:11+08:00',
    });

    assert.ok(parsed.summary);
    assert.equal(parsed.summary.coversTurn, 6);
    assert.ok(parsed.summary.text.includes('callout'));

    assert.equal(parsed.turns.length, 1);
    const turn = parsed.turns[0];
    assert.equal(turn.id, 7);
    assert.equal(turn.userText, '搜索一下 syncthing 冲突文件的最新处理方案，给我一个对比');
    assert.equal(turn.thinks.length, 1);
    assert.equal(turn.thinks[0].elapsedSecs, 41);
    assert.ok(turn.thinks[0].text.includes('冲突文件处理'));

    assert.equal(turn.searches.length, 1);
    assert.deepEqual(turn.searches[0].queries, ['syncthing conflict resolution']);
    assert.equal(turn.searches[0].results.length, 2);
    assert.equal(turn.searches[0].results[0].title, 'Syncthing Docs — Syncing');

    assert.equal(turn.bodyBlocks.length, 3);
    assert.ok(turn.bodyBlocks[0].includes('冲突处理有两条路线'));
    assert.equal(turn.inProgress, false);
    assert.equal(turn.aiBeginId, 42);

    assert.equal(turn.meta.user_msg, '41');
    assert.equal(turn.meta.ai_msg, '42');
    assert.equal(turn.meta.model, 'expert');
    assert.equal(turn.meta.route, 'local');
  });

  it('parses route meta for openclaw', () => {
    const md = `<!-- turn:1 user_msg=1 ai_msg=2 route=openclaw -->
> [!user]
> hello

<!-- ai:begin id=2 -->
ok
<!-- ai:end -->
`;
    const parsed = parseSession(md);
    assert.equal(parsed.turns.length, 1);
    assert.equal(parsed.turns[0].meta.route, 'openclaw');
  });

  it('marks a turn without ai:end as inProgress', () => {
    const md = `<!-- turn:1 user_msg=1 ai_msg=2 -->
> [!user]
> hello

<!-- ai:begin id=2 -->
writing...
`;
    const parsed = parseSession(md);
    assert.equal(parsed.turns.length, 1);
    assert.equal(parsed.turns[0].inProgress, true);
    assert.equal(parsed.turns[0].bodyBlocks.length, 1);
    assert.equal(parsed.turns[0].bodyBlocks[0], 'writing...');
  });
});

describe('serializeTurn / appendTurn roundtrip', () => {
  it('serializes and appends a turn then parses it back', () => {
    const turn = {
      id: 8,
      userText: 'roundtrip test',
      thinks: [{ elapsedSecs: 5, text: 'thinking...' }],
      searches: [{
        queries: ['q1'],
        results: [{ index: 1, title: 'T', url: 'https://x', site: 'x' }],
      }],
      bodyBlocks: ['body paragraph'],
      meta: { user_msg: '10', ai_msg: '11', model: 'expert', route: 'openclaw' },
      inProgress: false,
      aiBeginId: 11,
    };

    const initial = serializeTurn(turn);
    assert.ok(initial.includes('<!-- turn:8'));
    assert.ok(initial.includes('route=openclaw'));
    assert.ok(initial.includes('> [!think]- 已思考 · 5 秒'));
    assert.ok(initial.includes('<!-- ai:end -->'));

    const appended = appendTurn('', turn);
    const parsed = parseSession(appended);
    assert.equal(parsed.turns.length, 1);
    assert.equal(parsed.turns[0].id, 8);
    assert.equal(parsed.turns[0].userText, 'roundtrip test');
    assert.equal(parsed.turns[0].bodyBlocks[0], 'body paragraph');
    assert.equal(parsed.turns[0].searches[0].results[0].title, 'T');
    assert.equal(parsed.turns[0].meta.route, 'openclaw');
  });
});

describe('writeSummary', () => {
  it('inserts a summary at the top and removes an old one', () => {
    const md = `<!-- turn:1 user_msg=1 ai_msg=2 -->
> [!user]
> hi

<!-- ai:begin id=2 -->
ok
<!-- ai:end -->
`;
    const updated = writeSummary(md, 1, 'previous context');
    assert.ok(updated.includes('<!-- summary covers=1 -->'));
    assert.ok(updated.includes('前情摘要（覆盖至第 1 轮）'));
    const parsed = parseSession(updated);
    assert.equal(parsed.summary.coversTurn, 1);
    assert.equal(parsed.summary.text, 'previous context');
    assert.equal(parsed.turns.length, 1);
  });
});

describe('buildMessages', () => {
  it('does not return think/search/file/meta in messages', () => {
    const parsed = parseSession(sampleMd);
    const messages = buildMessages(parsed, { tokenBudgetChars: 100000 });
    assert.ok(messages.length >= 2);
    assert.equal(messages[0].role, 'user');
    assert.ok(messages[0].content.includes('前情摘要'));

    for (const m of messages) {
      assert.ok(!m.content.includes('> [!think]'));
      assert.ok(!m.content.includes('> [!search]'));
      assert.ok(!m.content.includes('<!-- turn:'));
      assert.ok(!m.content.includes('<!-- ai:'));
    }
  });

  it('respects summary coverage and excludes covered turns', () => {
    const parsed = parseSession(sampleMd);
    const messages = buildMessages(parsed, { tokenBudgetChars: 100000 });
    const userMessages = messages.filter(m => m.role === 'user');
    // summary + current user
    assert.equal(userMessages.length, 2);
    assert.ok(userMessages[1].content.includes('syncthing'));
  });

  it('excludes inProgress turns', () => {
    const md = `<!-- turn:1 user_msg=1 ai_msg=2 -->
> [!user]
> hello

<!-- ai:begin id=2 -->
writing...
`;
    const parsed = parseSession(md);
    const messages = buildMessages(parsed, { tokenBudgetChars: 100000 });
    assert.equal(messages.length, 0);
  });

  it('drops oldest turns when over budget while keeping summary', () => {
    const parsed = parseSession(sampleMd);
    const messagesBig = buildMessages(parsed, { tokenBudgetChars: 100000 });
    const summaryLen = messagesBig[0].content.length;

    // Tight budget: only summary fits, current turn dropped.
    const messagesSmall = buildMessages(parsed, { tokenBudgetChars: summaryLen + 5 });
    assert.equal(messagesSmall.length, 1);
    assert.ok(messagesSmall[0].content.includes('前情摘要'));
    assert.ok(!messagesSmall.some(m => m.role === 'assistant'));

    // Slightly larger budget: current turn pair fits.
    const pairLen = messagesBig
      .slice(1)
      .reduce((sum, m) => sum + m.content.length, 0);
    const messagesMedium = buildMessages(parsed, { tokenBudgetChars: summaryLen + pairLen });
    assert.ok(messagesMedium.some(m => m.role === 'assistant' && m.content.includes('冲突副本')));
  });

  it('includes contextMessages in budget and drops history before summary', () => {
    const parsed = parseSession(sampleMd);
    const contextMessages = [{ role: 'system', content: 'context'.repeat(100) }];
    const messages = buildMessages(parsed, { tokenBudgetChars: 100000, contextMessages });
    assert.ok(messages.some(m => m.role === 'system' && m.content.includes('context')));

    // 当上下文段占满预算时，历史轮次要被丢弃
    const tight = buildMessages(parsed, { tokenBudgetChars: contextMessages[0].content.length + 5, contextMessages });
    assert.equal(tight.length, 2); // summary + context
    assert.ok(!tight.some(m => m.role === 'assistant'));
  });
});

describe('extractWikilinks', () => {
  it('extracts simple wikilinks', () => {
    assert.deepEqual(extractWikilinks('请看 [[笔记A]] 和 [[笔记B]]'), ['笔记A', '笔记B']);
  });

  it('extracts link text before display alias', () => {
    assert.deepEqual(extractWikilinks('[[笔记A|显示名]]'), ['笔记A']);
  });

  it('deduplicates repeated links', () => {
    assert.deepEqual(extractWikilinks('[[笔记A]] [[笔记A]]'), ['笔记A']);
  });

  it('returns empty array when no links', () => {
    assert.deepEqual(extractWikilinks('plain text'), []);
  });
});

describe('resolveWikilinks', () => {
  function makeVaultIO(entries) {
    return {
      read: async (path) => entries[path] || '',
      exists: async (path) => path in entries,
      list: async () => Object.keys(entries).filter((p) => p.endsWith('.md')),
    };
  }

  it('resolves existing notes into a system context message', async () => {
    const vaultIO = makeVaultIO({
      '笔记A.md': '内容A',
      '笔记B.md': '内容B',
    });
    const result = await resolveWikilinks('[[笔记A]] [[笔记B]]', vaultIO, { budgetChars: 10000 });
    assert.equal(result.contextMessages.length, 1);
    assert.equal(result.contextMessages[0].role, 'system');
    assert.ok(result.contextMessages[0].content.includes('以下来自用户 Obsidian 笔记《笔记A》（路径：笔记A.md）'));
    assert.ok(result.contextMessages[0].content.includes('以下来自用户 Obsidian 笔记《笔记B》（路径：笔记B.md）'));
    assert.ok(result.contextMessages[0].content.includes('由插件自动注入，非用户粘贴'));
    assert.deepEqual(result.missing, []);
  });

  it('reports missing notes without blocking', async () => {
    const missing = [];
    const vaultIO = makeVaultIO({ '笔记A.md': '内容A' });
    const result = await resolveWikilinks('[[笔记A]] [[不存在]]', vaultIO, {
      budgetChars: 10000,
      onMissing: (names) => missing.push(...names),
    });
    assert.equal(result.contextMessages.length, 1);
    assert.deepEqual(missing, ['不存在']);
    assert.deepEqual(result.missing, ['不存在']);
  });

  it('truncates long notes within budget', async () => {
    const vaultIO = makeVaultIO({ '长笔记.md': 'x'.repeat(200) });
    const result = await resolveWikilinks('[[长笔记]]', vaultIO, { budgetChars: 60 });
    assert.equal(result.contextMessages.length, 1);
    assert.ok(result.contextMessages[0].content.includes('x'.repeat(10)));
    assert.ok(result.contextMessages[0].content.includes('已截断'));
  });

  it('returns empty context when all links missing', async () => {
    const vaultIO = makeVaultIO({});
    const result = await resolveWikilinks('[[不存在]]', vaultIO, { budgetChars: 10000 });
    assert.equal(result.contextMessages.length, 0);
    assert.deepEqual(result.missing, ['不存在']);
  });

  it('resolves notes in subdirectories by basename', async () => {
    const vaultIO = makeVaultIO({
      'notes/笔记A.md': '子目录内容A',
      '笔记B.md': '根目录内容B',
    });
    const result = await resolveWikilinks('[[笔记A]] [[笔记B]]', vaultIO, { budgetChars: 10000 });
    assert.equal(result.contextMessages.length, 1);
    assert.ok(result.contextMessages[0].content.includes('（路径：notes/笔记A.md）'));
    assert.ok(result.contextMessages[0].content.includes('子目录内容A'));
    assert.ok(result.contextMessages[0].content.includes('（路径：笔记B.md）'));
    assert.deepEqual(result.missing, []);
  });

  it('resolves notes in nested subdirectories', async () => {
    const vaultIO = makeVaultIO({
      'notes/Notes/X.md': '嵌套内容',
    });
    const result = await resolveWikilinks('[[X]]', vaultIO, { budgetChars: 10000 });
    assert.equal(result.contextMessages.length, 1);
    assert.ok(result.contextMessages[0].content.includes('（路径：notes/Notes/X.md）'));
    assert.ok(result.contextMessages[0].content.includes('嵌套内容'));
    assert.deepEqual(result.missing, []);
  });

  it('resolves ambiguous basenames to the shortest path and labels it', async () => {
    const vaultIO = makeVaultIO({
      'X.md': '根目录X',
      'notes/X.md': '子目录X',
      'notes/Notes/X.md': '嵌套X',
    });
    const result = await resolveWikilinks('[[X]]', vaultIO, { budgetChars: 10000 });
    assert.equal(result.contextMessages.length, 1);
    assert.ok(result.contextMessages[0].content.includes('（路径：X.md）'));
    assert.ok(result.contextMessages[0].content.includes('根目录X'));
    assert.ok(!result.contextMessages[0].content.includes('子目录X'));
    assert.deepEqual(result.missing, []);
  });

  it('still resolves root-level notes', async () => {
    const vaultIO = makeVaultIO({
      'Daily.md': '日记内容',
    });
    const result = await resolveWikilinks('[[Daily]]', vaultIO, { budgetChars: 10000 });
    assert.equal(result.contextMessages.length, 1);
    assert.ok(result.contextMessages[0].content.includes('（路径：Daily.md）'));
    assert.ok(result.contextMessages[0].content.includes('日记内容'));
    assert.deepEqual(result.missing, []);
  });

  it('includes source label in injected context', async () => {
    const vaultIO = makeVaultIO({
      '笔记A.md': '内容A',
    });
    const result = await resolveWikilinks('[[笔记A]]', vaultIO, { budgetChars: 10000 });
    assert.equal(result.contextMessages.length, 1);
    assert.ok(result.contextMessages[0].content.includes('以下来自用户 Obsidian 笔记《笔记A》（路径：笔记A.md），由插件自动注入，非用户粘贴：'));
  });

  it('reports missing while still injecting resolved links', async () => {
    const missing = [];
    const vaultIO = makeVaultIO({
      'notes/笔记A.md': '子目录内容A',
    });
    const result = await resolveWikilinks('[[笔记A]] [[不存在]]', vaultIO, {
      budgetChars: 10000,
      onMissing: (names) => missing.push(...names),
    });
    assert.equal(result.contextMessages.length, 1);
    assert.ok(result.contextMessages[0].content.includes('子目录内容A'));
    assert.deepEqual(missing, ['不存在']);
    assert.deepEqual(result.missing, ['不存在']);
  });
});
