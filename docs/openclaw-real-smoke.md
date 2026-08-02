# OpenClaw 真实 Gateway 冒烟报告（R4）

> 时间：2026-08-02
> 执行环境：本地 Windows + Git Bash + Node v24.17.0
> 凭证来源：`claw-cred.txt`（已 gitignore，未提交）

## 真实 Endpoint

当前使用 Tailscale 内网地址（绕过 VPS 公网安全组）：

```
ws://100.69.11.71:18789
```

> token 已打码，未写入本文档或任何脚本/日志。

## 握手验证结果

**部分通过。TCP/WebSocket 连接已建立，clarity 方言握手正常，但 `chat.send` 因 token 权限不足被拒绝。**

### 诊断记录

1. **Tailscale 内网可达**：
   ```
   ping -n 3 100.69.11.71
   Reply from 100.69.11.71: bytes=32 time=493ms TTL=64
   Reply from 100.69.11.71: bytes=32 time=2742ms TTL=64
   Reply from 100.69.11.71: bytes=32 time=493ms TTL=64
   ```

2. **HTTP 200 OK**：
   ```
   curl -s http://100.69.11.71:18789/
   → 返回 OpenClaw Control 页面
   ```

3. **WebSocket upgrade 成功并收到 `connect.challenge`**：
   ```
   HTTP/1.1 101 Switching Protocols
   {"type":"event","event":"connect.challenge","payload":{"nonce":"...","ts":...}}
   ```
   说明真实 gateway 使用与 clarity-gateway 相同的 challenge-response 方言，不需要 `simpleConnect` 极简模式。

4. **connect 成功**：将 `client.id` 改为 `"cli"`、`client.mode` 改为 `"cli"` 后，connect 握手通过，收到 hello-ok 等价响应。

5. **`chat.send` 失败**：
   ```
   OpenClaw chat.send failed: missing scope: operator.write
   ```
   当前使用的 admin token 在 WebSocket `auth.token` 位置通过认证，但缺少 `operator.write` scope，无法调用 `chat.send`。

## 协议方言差异

- **connect 载荷**：真实 gateway 与 clarity-gateway 方言一致，字段结构相同。
- **client.id 白名单**：必须是 `"cli"`、`"web"` 或 `"gateway-client"` 等常量。`"cli"` 可过。
- **client.mode**：必须是 `"cli"`（或 `"web"` 等常量），不能是 `"operator"`。
- **scope 要求**：`chat.send` 需要 `operator.write`；当前 admin token 虽未报错 connect，但在 `chat.send` 时被拒。

## 已做的最小化适配

为匹配真实 gateway，已在 `src/openclaw-provider.js` 调整 connect 载荷默认值：

- `client.id` 默认值从 `"gateway-client"` 改为 `"cli"`；
- `client.version` 从 `"0.0.1"` 改为 `"1.0.0"`；
- `client.platform` 从 `"obsidian-ai-vault"` 改为 `"linux"`；
- `client.mode` 从 `"cli"` 改为 `"cli"`（明确为常量）；
- `scopes` 默认使用 `["operator.read", "operator.write"]`；
- 保留 `simpleConnect` 选项（默认 `false`），供未来极简 gateway 使用。

### 改动文件

- `src/openclaw-provider.js`：connect 载荷默认值调整。
- `scripts/openclaw-real-smoke.mjs`：不再硬编码 `clientId`，使用 provider 默认值。

### 回归验证

```bash
npm test -- test/openclaw-provider.test.js
```

结果：4/4 通过，clarity mock 行为未受影响。

## 单轮 chat 日志

**未产生。** `chat.send` 因 scope 不足被拒绝，未进入 `ChatChunk` / `ReasoningChunk` / `Done` 事件流，无 vault md 落盘可检查。

## 是否通过 R4

**未通过。**

阻塞原因：admin token 缺少 `operator.write` scope，无法完成 `connect → chat.send → done` 的最小流式验证。

## 下一步建议

1. **方案 A（推荐，符合阶段 1 不做配对的裁决）**：让 Gray-Cloud 在真实 gateway 上为当前 admin token 授予 `operator.write` scope，然后重跑 `node scripts/openclaw-real-smoke.mjs`。
2. **方案 B**：若 admin token 不能加 `operator.write`，则阶段 1 必须引入最小设备配对流程：用 admin token 调用 HTTP API 批准配对请求，拿到 device operator token 后再以 `client.id="gateway-client"` 重连。
3. 流式事件语义、sessionKey 行为、普通笔记落盘验证需待 `chat.send` 通过后再补。
