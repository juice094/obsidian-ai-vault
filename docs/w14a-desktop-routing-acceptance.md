# W14a 桌面轨道「模型路由 A/B」UX 落地 — 验收报告

## 改动清单

| 文件 | 改动 |
|------|------|
| `main.ts` | 新增 `defaultRoute` / `openclawUrl` / `openclawToken` / `clientId` 设置；新增「模型路由」设置区；会话视图顶部加路由下拉切换；`createEngine` 按当前路由构造 `SessionEngine` 并校验 OpenClaw 必填项。 |
| `src/engine.js` | `SessionEngine` 增加 `route` 与 `clientId` 参数；`_resolveProvider` 校验 OpenClaw URL/Token 并把 `clientId` 透传给 `OpenClawProvider`；`makeMeta` 写入 `route=local\|openclaw`。 |
| `src/engine.d.ts` | 补全 `clientId` 与 `route` 类型声明。 |
| `test/format.test.js` | 在 sample fixture 中增加 `route=local`；新增 `parses route meta for openclaw` 用例；roundtrip 用例验证 `route=openclaw` 可序列化/解析。 |
| `scripts/w14a-smoke.mjs` | 新增头对头冒烟脚本，支持 `local` / `openclaw` 两种路由，OpenClaw token 仅从环境变量读取。 |

> 未改动 `src/openclaw-provider.js`、`src/openai-compat-provider.js`、`src/format.js` 的解析逻辑。
> 凭证（`openclawToken`）只保存在 Obsidian 插件 `data.json`，未进入日志或提交。

## 自动化测试结果

```bash
npm test
# ℹ tests 23
# ℹ pass 23
# ℹ fail 0

npx tsc --noEmit
# （无输出，通过）

npm run build
# （esbuild 成功生成 main.js）
```

## 真实端点验证

### 路由 A：本地 DeepSeek gateway

已有服务监听 `127.0.0.1:18791`（`deepseek-device-skill serve`）。运行冒烟脚本：

```bash
node scripts/w14a-smoke.mjs local "你好"
```

结果：**通过**。生成的 turn meta 包含 `route=local`：

```html
<!-- turn:1 user_msg=2 ai_msg=1 model=deepseek-chat route=local tokens=39 time=2026-08-03T08:11:28.336Z -->
```

AI 回复正常，事件流完整（`user-saved` → 多段 `content-delta` → `turn-done`）。

### 路由 B：OpenClaw agent（Tailscale 端点）

端点：`ws://100.69.11.71:18789`，使用 `claw-cred.txt` 中的 `deviceToken`/`token` 均失败：

- `deviceToken` → `OpenClaw connect failed: unauthorized: gateway token mismatch`
- `token` 字段 → 连接成功，但 `chat.send` 返回 `missing scope: operator.write`

示例失败帧（token 已打码）：

```json
{"type":"res","id":"...","ok":false,"error":{"code":"INVALID_REQUEST","message":"missing scope: operator.write"}}
```

结论：**当前服务端未授权 `operator.write` scope，路由 B 无法完成对话**。这是服务端权限/配对状态问题，不是 provider 或插件代码问题。完整帧捕获见 `docs/openclaw-real-smoke-frames.json`。

## UI 验证说明

本次在 headless 环境下完成代码与端到端冒烟验证，未能在真实 Obsidian 桌面窗口中截取设置页/会话视图/两种 meta 差异的截图。建议后续人工在 Obsidian 中补做以下截图：

1. 设置页「模型路由」区（默认路由、OpenClaw URL/Token/Client ID）。
2. 会话视图顶部路由下拉（本地 / OpenClaw）与当前路由标签。
3. 同一会话先走本地、再切 OpenClaw 后生成的两段 turn meta 差异（`route=local` vs `route=openclaw`）。

## 阻塞/偏差

| 项目 | 状态 | 说明 |
|------|------|------|
| 路由 A 本地对话 | ✅ 通过 | 端到端冒烟成功，meta 正确记录 `route=local`。 |
| 路由 B OpenClaw 对话 | ❌ 阻塞 | 服务端返回 `missing scope: operator.write`，需 OpenClaw gateway 侧重新授权/配对。 |
| Obsidian UI 截图 | ⏸️ 未执行 | 当前为无头环境，建议在桌面端补截图。 |
| `openclawToken` 存储 | ✅ 合规 | 仅写入插件 `data.json`，未硬编码、未入日志。 |
