# OpenClaw 决策文档评审（指挥层 · 2026-07-30）

**对象**：`docs/openclaw-decision.md`（`6a97f00`，W7 产物）
**结论：批准，按下列条件执行。** 决策本身（方案 B、分阶段、不内嵌 Rust 运行时）
符合 ponytail 原则与 T3 provider 抽象，风险清单诚实（mock 验证已如实标注）。

## 代码核实记录（评审时已逐条验证）

| 决策文档声明 | 核实结果 |
|---|---|
| T2 对不认识的 callout 默认不回传上下文 | ✅ 属实。`src/format.js:117-128`：`parseCallout` 解析后仅 user/think/search 入上下文，其余 type 静默跳过 |
| v1.1 的 `<!-- tool_call:... -->` 注释不与现有标记冲突 | ✅ 属实。`format.js:5-8` 四个正则（turn/summary/ai:begin/ai:end）均不匹配该前缀 |
| 升级向后兼容 | ✅ 基本属实，但见修正项 R3 的边缘情况 |

另核实了引擎写盘路径（决策文档未覆盖的一点）：流式重写是**文本前缀拼接**
（`engine.js:111-117` 取当前 turn marker 前的原始文本 + `serializeTurn`），
不按解析模型重序列化历史 turn——**历史 turn 里的 v1.1 块不会被流式写盘抹掉**。
这支撑了"先预留格式、后实现"的可行性。

## 裁决

1. **md 格式冻结状态不变**。v1.1 的 `[!tool]`/`[!approval]` 仅是预留，
   **现在不改 T2 解析器、不改任何序列化代码**。阶段 2 立项时再定稿字段结构。
2. **批准方案 B 分阶段**。阶段 1 scope 冻结：admin token 认证、`ChatChunk`/`Done`
   映射到现有 md 结构、不启用工具/审批、Ed25519 配对不实现。
3. **不采用方案 C 的裁决生效**，后续不再重议（除非阶段 2 证明 JS 侧配对无路可走）。

## 修正项（实现任务包必须吸收）

- **R1. status 字段双重存储**：决策文档样例里 HTML 注释（`status=pending|approved`）
  与 callout 正文（`> status: approved`）各存一份状态。定稿时以 **HTML 注释为机器
  唯一事实源**，正文只放人读文本。避免两处漂移。
- **R2. `chat.abort` 缺口**：OpenClaw 未实现 abort（决策文档 3.2 已列但决策节未处理）。
  阶段 1 任务包须写明路由 B 下的中断 fallback：关闭 WS 连接 + 按现有语义写
  `> [!warning] 本轮中断`，与路由 A 的 resume 体验对齐。
- **R3. resume 抹块边缘情况**：inProgress turn 被 resume 重生成时按解析模型序列化，
  该 turn 内的 tool/approval 块会丢失。阶段 2 定稿时二选一：tool/approval 块移出
  turn 重生成范围，或解析器保真未知块。阶段 1 无工具块，不触发。
- **R4. 真实 gateway 冒烟是阶段 1 验收门禁**：spike 只验证了 mock server。
  `OpenClawProvider` 完成后必须对真实 clarity-gateway 跑通一轮
  `connect → chat.send → done`；URL/端点路径（`/openclaw/ws` vs `/ws`）与 token
  由指挥层/用户提供，配置化不硬编码。

## 轨道归属（按 PLAN-round2-handover 三之二节）

- `OpenClawProvider`：共享核心（obsidian-ai-vault `src/`），改动后桌面/Android 两轨道各自回归。
- 路由 A/B 配置 UI：各轨道独立——桌面轨道进插件设置页；Android 轨道进输入坞/设置注入，
  功能集不要求同步。

## 下一步

新增任务包 **W9：OpenClawProvider 阶段 1（共享核心）**，委托词待用户排期后另发；
与 W4/W5/W6 无依赖，可并行。阶段 2（配对 + 工具/审批 UI）在 W9 验收后另行立项。
