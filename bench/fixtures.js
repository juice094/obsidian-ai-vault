// 性能基准测试：合成会话 fixture
// 零依赖，Node 18+ ESM。

const TOPICS = [
  'syncthing 冲突文件处理',
  'Rust 异步运行时选型',
  'Android 前台服务生命周期',
  'Capacitor WebView 注入',
  'Obsidian 插件开发',
  '端到端加密同步',
  'LLM 流式输出协议',
  'Claw WebSocket 配对',
];

function pick(array, seed) {
  return array[Math.abs(seed) % array.length];
}

function loremParagraph(seed, sentences = 12) {
  const topic = pick(TOPICS, seed);
  const parts = [];
  for (let i = 0; i < sentences; i++) {
    parts.push(`这是关于 ${topic} 的第 ${seed + i + 1} 句说明，用于模拟真实回复中的自然语言段落，并且包含足够的字符数以逼近真实会话的体积分布。`);
  }
  return parts.join('');
}

function codeBlock(seed) {
  return [
    '```rust',
    `fn example_${seed % 1000}() -> Result<(), Box<dyn std::error::Error>> {`,
    '    let data = vec![1, 2, 3, 4, 5];',
    '    let sum: i32 = data.iter().sum();',
    `    println!("sum = {}", sum);`,
    '    if sum > 0 {',
    '        println!("positive");',
    '    }',
    '    Ok(())',
    '}',
    '',
    `fn helper_${seed % 1000}(x: i32) -> i32 {`,
    '    x * 2 + 1',
    '}',
    '```',
  ].join('\n');
}

function tableBlock(seed) {
  return [
    '| 方案 | 延迟 | 复杂度 | 适用场景 | 备注 |',
    '| --- | --- | --- | --- | --- |',
    `| A-${seed} | 低 | 低 | 原型 | 快速验证 |`,
    `| B-${seed} | 中 | 中 | 生产 | 推荐 |`,
    `| C-${seed} | 高 | 高 | 大规模 | 需谨慎 |`,
    `| D-${seed} | 可变 | 中 | 边缘场景 | 兜底 |`,
  ].join('\n');
}

function listBlock(seed) {
  return [
    `1. 步骤一：初始化环境并检查依赖版本 ${seed}`,
    `2. 步骤二：加载配置文件并校验格式 ${seed}`,
    `3. 步骤三：启动后台服务并注册生命周期回调 ${seed}`,
    `4. 步骤四：建立与对端的连接并验证握手 ${seed}`,
    `5. 步骤五：执行核心任务并记录日志 ${seed}`,
    `6. 步骤六：优雅关闭并清理临时资源 ${seed}`,
  ].join('\n');
}

function bodyForTurn(seed) {
  const type = seed % 4;
  const para1 = loremParagraph(seed, 6 + (seed % 5));
  const para2 = loremParagraph(seed + 1000, 4 + (seed % 4));
  switch (type) {
    case 0:
      return [para1, codeBlock(seed), para2].join('\n\n');
    case 1:
      return [para1, listBlock(seed), para2].join('\n\n');
    case 2:
      return [para1, tableBlock(seed), para2].join('\n\n');
    default:
      return [para1, listBlock(seed), codeBlock(seed + 1), para2].join('\n\n');
  }
}

function nowIso() {
  return new Date().toISOString();
}

export function generateFixture(rounds) {
  const frontmatter = [
    '---',
    'chat_format: 1',
    `session_id: bench-${rounds}-${Date.now()}`,
    'model: expert',
    'thinking: true',
    'search: true',
    `created: ${nowIso()}`,
    '---',
    '',
  ].join('\n');

  const turnBlocks = [];
  for (let i = 1; i <= rounds; i++) {
    const userText = `请介绍一下 ${pick(TOPICS, i * 7)} 的实践经验（第 ${i} 轮）`;
    const body = bodyForTurn(i);
    const userLen = userText.length;
    const aiId = i * 1000;
    const tokens = 200 + (i % 500);
    const turnMd = [
      `<!-- turn:${i} user_msg=${userLen} ai_msg=${aiId} model=expert tokens=${tokens} time=${nowIso()} -->`,
      '> [!user]',
      `> ${userText}`,
      '',
      `> [!search]- 已阅读 4 个网页 · "benchmark topic ${i}"`,
      `> 1. [Reference A](https://example.com/a/${i}) — example.com`,
      `> 2. [Reference B](https://example.com/b/${i}) — example.com`,
      `> 3. [Reference C](https://example.com/c/${i}) — example.com`,
      `> 4. [Reference D](https://example.com/d/${i}) — example.com`,
      '',
      '> [!think]- 已思考 · 11 秒',
      `> 思考链第 ${i} 段：先分析问题边界，再给出具体建议。`,
      `> 然后评估各种可行方案在目标场景下的优劣。`,
      `> 最后给出最小改动、最可维护的推荐做法。`,
      '',
      `<!-- ai:begin id=${aiId} -->`,
      body,
      '<!-- ai:end -->',
    ].join('\n');
    turnBlocks.push(turnMd);
  }

  return frontmatter + turnBlocks.join('\n\n---\n\n') + '\n';
}

// CLI: node bench/fixtures.js 200
const isCli = process.argv[1] && process.argv[1].replace(/\\/g, '/').endsWith('bench/fixtures.js');
if (isCli) {
  const rounds = parseInt(process.argv[2] || '50', 10);
  process.stdout.write(generateFixture(rounds));
}
