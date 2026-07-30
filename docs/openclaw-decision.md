# OpenClaw 传输调研与 R2 路由 B 决策

> 任务来源：`obsidian-sync-android-bridge/docs/PLAN-ai-sessions.md` T7 节
> 调研仓库：\`C:/Users/22414/dev/clarity\`（只读，未修改任何文件）
> 实验产物：\`scripts/openclaw-spike.cjs\`、\`docs/openclaw-spike-sample.json\`

## 一、背景

T7 要求判断两条技术路线：

1. md 会话格式是否要从 v1 升级到 v1.1；
2. R2（Android 内置 gateway）的路由 B 是否采用 OpenClaw（Claw WebSocket 协议）。

OpenClaw 是 clarity 项目为 Kimi Desktop / Claw Gateway 定义的 JSON-RPC over WebSocket 协议，
支持 admin token、Ed25519 设备配对、session/chat/agent 事件流、设备配对审批等。
当前 `clarity-gateway` 已在 `0.0.0.0:18790/openclaw/ws`（部分构建版本为 `/ws`）暴露兼容端点。

## 二、候选方案

### 方案 A：不采用 OpenClaw，R2 只做本地 DeepSeek device API

- 路由 A 保持原计划：Android `.so` 内嵌 `deepseek-device-skill serve`，走 OpenAI 兼容 HTTP。
- 不实现路由 B；远程 agent 能力不在 Android 侧支持。

**优点**：实现范围最小，无 Ed25519/配对/UI 审批复杂度。
**缺点**：无法调用带工具/规划的完整 Claw agent；桌面与移动端能力分裂。

### 方案 B：R2 路由 B 采用 OpenClaw，JS 引擎侧新增 provider

- 在 `obsidian-ai-vault` 引擎里实现 `OpenClawProvider`，与现有 `OpenAICompatProvider` 互换。
- Android `.so` 侧预留路由选择配置：A = 本地 HTTP，B = 远程 WebSocket。
- 复用 clarity 的协议面和事件分类法，md 格式扩展 `> [!tool]` / `> [!approval]`。

**优点**：统一跨端 agent 能力；复用 clarity 生态的 pairing、session、审批语义；
        与 `PLAN-rust-performance.md` 修订 1 的"后端路由器"定位一致。
**缺点**：需要解决 Ed25519 配对在 WebView/JS 里的实现或绕过；需要新增 UI/格式语义。

### 方案 C：R2 内嵌完整 clarity-claw Rust 运行时

- 不通过 JS provider，而是在 Android `.so` 里直接链接 `clarity-claw` 的 TransportManager，
  JNI 暴露事件流给 JS。

**优点**：配对签名天然在 Rust 侧完成，JS 无加密负担。
**缺点**：大幅增加 `.so` 体积与编译复杂度；超出 R2 当前"路由器"定位；
        与 T3 provider 抽象冲突（引擎主体不应感知 provider 差异）。

## 三、协议面关键结论（基于源码分析）

### 3.1 连接建立

```text
Client ──WebSocket──> ws://host:18790/openclaw/ws
Server <── connect.challenge {nonce, ts}
Client ──> connect {minProtocol:3, maxProtocol:3, client:{id,version,platform,mode},
                   role, scopes[], auth:{token}, device?}
Server <── res {ok:true, payload:{type:hello-ok, protocol, server, features, policy}}
```

- `client.id` 在 clarity-gateway 的校验中必须是允许值（如 `gateway-client`/`openclaw-control-ui`），
  不能随意自定义。
- 设备配对时，`device` 块包含 Ed25519 公钥、签名、nonce、signedAt；
  签名载荷格式为 `v3|deviceId|clientId|clientMode|role|scopes|signedAt|token|nonce|platform|deviceFamily`。

### 3.2 方法

| 方法 | 作用 |
|---|---|
| `chat.send` | 向 session 发消息，可流式 |
| `chat.history` | 拉历史 |
| `chat.abort` | 中止当前生成（OpenClaw 未实现） |
| `sessions.list/preview/reset/delete/compact` | session 管理 |
| `device.pair.request/list` | 设备配对 |

### 3.3 事件分类（clarity-contract `TransportEvent`）

| 事件 | md 映射建议 |
|---|---|
| `Connected` | 引擎状态，不落 md |
| `ChatChunk` | `ai:begin/end` 正文增量 |
| `ReasoningChunk` | `> [!think]` 折叠 callout |
| `Done` | 写 `ai:end` + `---` |
| `History` | resume/初始加载时回填 |
| `DevicePaired` | 设置页状态，不落 md |
| `Reconnecting/Error/Closed` | `> [!warning]` 或 toast |
| `WirePayload` | 透传未知事件，未来兼容 |

### 3.4 工具与审批

- clarity 的 Agent 在 `ApprovalMode::Interactive` 下会产生 `ToolCall` 与审批请求。
- 当前 clarity-gateway 的 OpenClaw handler 对 `chat.send` 只做最简单的文本往返
  （`OpenClawServerTransport` → `GovernedTransport` → Agent），工具事件会出现在 Agent 事件流中。
- 若启用工具，事件流里需要新增 `tool_call` / `approval_request` 语义；
  v1.1 预留的 `> [!tool]` / `> [!approval]` 刚好覆盖，但字段结构需定稿。

## 四、决策

### 4.1 md 格式：升级到 v1.1

**决定**：升级。v1.1 已预留的两个 callout 类型名 `> [!tool]` 和 `> [!approval]` 足够覆盖 OpenClaw 场景，
且 T2 解析器对不认识 callout 的默认行为是"不回传上下文"，升级向后兼容。

**新增字段结构（供 T3/T5 实现时遵循）**：

```markdown
<!-- tool_call:id=tc-1 name=file_read status=pending|done -->
> [!tool] file_read
> path: `docs/PLAN-ai-sessions.md`
> result: ...

<!-- approval:id=ap-1 tool=file_write status=pending|approved|rejected -->
> [!approval] file_write
> 请求写入 `docs/test.md`，请确认。
> status: approved
```

- tool/approval 块同样**不回传上下文**（与 think/search/file 一致），只作为审计/展示。
- 审批状态写入 md，保留可追溯性，符合"会话即笔记"模型。

### 4.2 R2 路由 B：采用 OpenClaw，但分阶段实现

**决定**：采用方案 B，JS provider 方式。

**阶段 1（R2 当前）**：
- 只做 admin token 认证，不做 Ed25519 运行时配对；
- 配置里填 `openclawUrl` + `openclawToken`；
- 实现 `OpenClawProvider.streamChat()`，消费 `ChatChunk`/`Done`，映射到现有 md 结构；
- 不启用工具/审批，避免 UI 和格式双重爆炸。

**阶段 2（后续任务包）**：
- 需要设备配对时，使用预配对 token（桌面生成后通过安全通道注入 Android）或新增 Rust JNI helper；
- 启用 `> [!tool]` / `> [!approval]`，补齐审批 UI。

**不采用方案 C**：内嵌完整 clarity-claw Rust 运行时会破坏 T3 provider 抽象，且体积/编译成本过高。

## 五、风险清单

| 风险 | 级别 | 说明与缓解 |
|---|---|---|
| JS 中 Ed25519 配对签名 | 高 | WebView WebCrypto 对 Ed25519 支持有限；阶段 1 用 admin token 绕过，阶段 2 用预注入 device token 或 Rust helper。 |
| 端口/端点不一致 | 中 | clarity-gateway 不同构建的 OpenClaw 路径可能是 `/openclaw/ws` 或 `/ws`；配置化 URL，不要硬编码。 |
| 事件流版本漂移 | 中 | clarity 事件分类（`TransportEvent`、`WirePayload`）可能扩展；provider 保留未知事件透传，md 格式对未知 callout 默认不回传。 |
| 工具/审批 UI 复杂度 | 中 | Obsidian 注入脚本里渲染审批按钮需要 DOM 注入；阶段 1 不启用，阶段 2 再立项。 |
| 真实 gateway 凭证 | 中 | 本次 spike 因本机 18790 已被占用且 token 未知，使用 mock server 验证协议脚本；正式集成需指挥层提供/确认 gateway 配置。 |
| Agent 并发限制 | 低 | clarity-gateway 用 `agent_turn_sem` 串行化单 Agent 多连接；不影响单用户会话。 |

## 六、实验记录

- **spike 脚本**：`scripts/openclaw-spike.cjs`（Node 原生 WebSocket，零依赖）。
- **运行方式**：`MOCK_TOKEN=mock-admin-token node scripts/openclaw-mock-server.cjs` 起 mock，
  再 `OPENCLAW_URL=ws://127.0.0.1:18792/ws OPENCLAW_ADMIN_TOKEN_FILE=/tmp/mock-token.txt node scripts/openclaw-spike.cjs`。
- **采样输出**：`docs/openclaw-spike-sample.json`，包含完整的 `connect.challenge` → `connect` → `hello-ok` →
  `chat.send` → `chat` 事件流 → `done` 生命周期。
- **与真实 clarity-gateway 的差异**：mock 未实现 device pairing、未承载真实 Agent；
  真实环境需替换 URL 与 admin token，并验证 `client.id` 等校验规则。

## 七、下一步

1. **T3 引擎**：新增 `OpenClawProvider` 实现，保持 `streamChat` async iterator 接口；
   先支持 admin token，session key 默认 `agent:main:main`。
2. **T5 Android 注入**：在设置页增加 OpenClaw URL/Token 配置，路由选择 A/B。
3. **R2 Rust 侧**：在 `deepseek-device-skill` 的 cdylib 里预留路由 B 配置入口，
   阶段 1 不实现 WebSocket client（由 JS 直接连），阶段 2 再评估是否内嵌配对签名。
4. **v1.1 格式落地**：T2 `format.js` 识别 `> [!tool]` / `> [!approval]` 块，
   序列化时保持字段结构，确保 parse/serialize 往返一致。
5. **正式集成前**：向指挥层确认真实 clarity-gateway 的 URL、OpenClaw 端点路径、admin token 或 pairing 方式。
