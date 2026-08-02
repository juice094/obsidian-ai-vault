# OpenClaw 真实 Gateway 冒烟报告（R4）

> 时间：2026-08-02  
> 执行环境：本地 Windows + Git Bash + Node v24.17.0  
> 凭证来源：`claw-cred.txt`（已 gitignore，未提交）

## 真实 Endpoint

本次使用 Tailscale 内网地址：

```
ws://100.69.11.71:18789
```

> 公网 `ws://49.232.19.208:18789` 此前因防火墙未放通 18789 无法连接；Tailscale 内网可直达。token 已打码，未写入本文档。

## 握手验证结果

**握手成功，但 chat.send 返回权限错误。同时服务端通过 `agent` 事件向同一 session 流式输出了内容。**

### 诊断记录

1. **Tailscale 端点可达**：
   ```
   ping -n 3 100.69.11.71
   Reply from 100.69.11.71: bytes=32 time=259ms TTL=64
   Reply from 100.69.11.71: bytes=32 time=248ms TTL=64
   Reply from 100.69.11.71: bytes=32 time=259ms TTL=64
   ```

2. **HTTP 根路径返回 OpenClaw Web UI**（curl 200）。

3. **WebSocket 握手**：provider 收到 `connect.challenge` → 发送 clarity 风格 `connect` req → 收到 `hello-ok` 等价响应，连接建立成功。

4. **chat.send 失败**：
   ```
   provider error: OpenClaw chat.send failed: missing scope: operator.write
   ```
   即 connect 阶段虽然请求了 `operator.read` + `operator.write`，但服务端最终未授予 `operator.write`，导致 chat.send 方法返回 `INVALID_REQUEST`。

5. **意外发现**：在 `chat.send` 返回错误后，服务端仍通过 `event: "agent"` 向 `sessionKey: "agent:main:main"` 流式推送了 assistant 文本（见下方「服务端响应证据」）。当前 provider 的事件映射只处理 `ChatChunk` / `ReasoningChunk` / `Done` / `chat`，未消费 `agent` 事件。

## 服务端响应证据

完整帧记录见同目录 `openclaw-real-smoke-frames.json`（token 已打码）。以下摘录关键帧。

### 1. connect.challenge

```json
{
  "type": "event",
  "event": "connect.challenge",
  "payload": {
    "nonce": "1a4f048c-0da6-4af9-965f-5ae29fd03925",
    "ts": 1785671952797
  }
}
```

### 2. connect 请求（client 发出，token 已打码）

```json
{
  "type": "req",
  "id": "62c93565-c8e9-479f-89ce-b39e99cb04c9",
  "method": "connect",
  "params": {
    "minProtocol": 3,
    "maxProtocol": 3,
    "client": {
      "id": "cli",
      "version": "1.0.0",
      "platform": "linux",
      "mode": "cli"
    },
    "role": "operator",
    "scopes": ["operator.read", "operator.write"],
    "auth": { "token": "***" },
    "caps": []
  }
}
```

### 3. hello-ok 响应（关键字段）

```json
{
  "type": "res",
  "id": "62c93565-c8e9-479f-89ce-b39e99cb04c9",
  "ok": true,
  "payload": {
    "type": "hello-ok",
    "protocol": 3,
    "server": {
      "version": "2026.4.14",
      "connId": "fcbc8ef8-e577-4fb4-b327-208f438100f4"
    },
    "features": {
      "methods": ["health", "...", "chat.send", "..."],
      "events": ["connect.challenge", "agent", "chat", "..."]
    },
    "snapshot": {
      "presence": [{
        "host": "VM-8-134-ubuntu",
        "ip": "10.209.8.134",
        "version": "2026.4.14",
        "platform": "linux 6.8.0-136-generic",
        "deviceFamily": "Linux",
        "modelIdentifier": "x64",
        "mode": "gateway",
        "reason": "self",
        "text": "Gateway: VM-8-134-ubuntu (10.209.8.134) · app 2026.4.14 · mode gateway · reason self",
        "ts": 1785671953251
      }],
      "health": { "ok": true, "...": "..." },
      "stateVersion": { "presence": 55, "health": 111 },
      "uptimeMs": 3920959,
      "sessionDefaults": {
        "defaultAgentId": "main",
        "mainKey": "main",
        "mainSessionKey": "agent:main:main",
        "scope": "per-sender"
      }
    },
    "policy": {
      "maxPayload": 26214400,
      "maxBufferedBytes": 52428800,
      "tickIntervalMs": 30000
    }
  }
}
```

**重要观察**：hello-ok 中**没有 `auth.scopes`、`auth.role` 或任何 granted scopes 字段**。这说明 connect 请求里声明的 `scopes` 只是客户端期望，服务端并未在响应中回显实际授权范围。

### 4. chat.send 响应

```json
{
  "type": "res",
  "id": "5818ddde-265d-40cd-85e2-abd5bf3b426d",
  "ok": false,
  "error": {
    "code": "INVALID_REQUEST",
    "message": "missing scope: operator.write"
  }
}
```

### 5. agent 事件（服务端主动推送，未被当前 provider 消费）

在 chat.send 返回错误后，服务端连续推送多条 `event: "agent"`：

```json
{
  "type": "event",
  "event": "agent",
  "payload": {
    "runId": "570c00f7-3e64-4b73-ac1e-84929682a99e",
    "stream": "assistant",
    "data": {
      "text": "**铁证如山。**\n\n```\nhello-ok.auth.scopes → NOT PRESENT\nhello-ok.auth.role   → NOT PRESENT\nchat.send            → missing scope: operator.write\n```\n\nshared-secret token 模式只做**认证**，不授予**任何 operator scope**。",
      "delta": " 对"
    },
    "sessionKey": "agent:main:main",
    "seq": 655,
    "ts": 1785671953298
  },
  "seq": 4192
}
```

该 `agent` 事件与 `chat.send` 错误内容相呼应，指出 shared-secret token 模式仅做认证、不授予 operator scope。当前 provider 将其忽略。

## 协议方言差异

1. **握手方言**：真实端使用标准 clarity-gateway 流程（`connect.challenge` → `req/connect` → `hello-ok`）。`simpleConnect` 极简模式未被触发。
2. **hello-ok 结构**：无 `auth.scopes` / `auth.role` 回显，无法从响应中得知服务端实际授予了哪些 scope。
3. **聊天事件**：服务端在 chat.send 报错后仍通过 `event: "agent"` 推送 assistant 内容；当前 provider 只识别 `ChatChunk` / `ReasoningChunk` / `Done` / `chat`，未处理 `agent`。
4. **权限策略**：shared-secret admin token 在该 gateway 上似乎只用于认证，不自动赋予 `operator.write`，导致 `chat.send` 被显式拒绝。

## 代码改动

- `src/openclaw-provider.js`：保留 `simpleConnect` 选项（默认关闭），未启用极简载荷改动；未保留失败的 `userAgent`/`caps` 微调。
- `scripts/openclaw-real-smoke.mjs`：
  - 支持命令行/环境变量覆盖 endpoint；
  - 增加 WebSocket 发送帧与接收帧双拦截，token/secret 类字段自动打码；
  - 运行结束后保存完整帧记录到 `docs/openclaw-real-smoke-frames.json`。
- `test/openclaw-provider.test.js`：同步 provider 当前默认 `cli` / `operator.write` 断言。

### 回归验证

```bash
npm test
```

结果：22/22 通过。

## R4b 最小设备配对尝试

> 任务来源：`obsidian-sync-android-bridge/docs/PLAN-round2-handover.md` R4b 节。  
> 目标：admin token 走 `node.pair.request` → 批准 → 拿到 device operator token → 以 `gateway-client` 重连 → 验证 hello-ok 带 `auth.scopes` → 跑通一轮真实流式 chat。

### 已完成的代码准备

- `src/openclaw-provider.js` 新增 `event: "agent"` 映射：
  - `payload.stream === 'reasoning'/'think'` → `{type:'reasoning', delta:data.delta|data.text}`；
  - 其他 `agent` 事件 → `{type:'content', delta:data.delta|data.text}`；
  - `payload.done === true || payload.finished === true` → `{type:'finish'}`。
- `scripts/openclaw-pair.mjs` 实现完整配对脚本：
  - 使用 Node `webcrypto.subtle` 生成 Ed25519 密钥对；
  - 按决策文档签名载荷格式 `v3|deviceId|clientId|clientMode|role|scopes|signedAt|token|nonce|platform|deviceFamily` 对 `node.pair.request` 签名；
  - 自动检测 `node.pair.approve` 是否在 tools 白名单，在白名单内则自动批准；否则等待 dashboard 人工批准；
  - 轮询 `node.pair.list` 提取 device operator token；
  - 用 device token 以 `client.id="gateway-client"` 重连并尝试 `chat.send`。

### 执行结果

**配对请求被拒绝，未拿到 device token，R4b 未完成。**

1. admin token 连接（`client.id="cli"`）成功，hello-ok 仍无 `auth.scopes`；
2. `connect` 请求 scopes 包含 `operator.read` / `operator.write` / `operator.pairing`；
3. `node.pair.request` 返回：
   ```json
   { "type": "res", "ok": false, "error": { "code": "INVALID_REQUEST", "message": "missing scope: operator.pairing" } }
   ```
4. 额外验证 `device.pair.request`（非任务要求，仅作对照），返回：
   ```json
   { "type": "res", "ok": false, "error": { "code": "INVALID_REQUEST", "message": "missing scope: operator.admin" } }
   ```

### R4b 关键帧摘录

admin connect 请求（token 已打码）：

```json
{
  "type": "req",
  "method": "connect",
  "params": {
    "minProtocol": 3,
    "maxProtocol": 3,
    "client": { "id": "cli", "version": "1.0.0", "platform": "linux", "mode": "cli" },
    "role": "operator",
    "scopes": ["operator.read", "operator.write", "operator.pairing"],
    "auth": { "token": "***" },
    "caps": []
  }
}
```

`node.pair.request` 请求（Ed25519 签名，token 已打码）：

```json
{
  "type": "req",
  "method": "node.pair.request",
  "params": {
    "device": {
      "id": "obsidian-ai-vault-0853b651-2208-4eb7-baf8-8882cf4dea80",
      "publicKey": "C65Jh6YXwgZKRQHm5bcqejmx2NV8CTPzTYqrUrR8SXw=",
      "signature": "PnmB37ir5b8wVgOFtlqpX/PBjRkyQSCoheunW6deFwZrmmyuWm9LfGOPOpVKvRJl3jCHZgZZzpLcHE2QAwscDw==",
      "nonce": "61abd362-a272-4d6d-94d3-34a16417c729",
      "signedAt": "2026-08-02T12:12:22.941Z"
    },
    "client": { "id": "cli", "version": "1.0.0", "platform": "linux", "mode": "cli" },
    "role": "operator",
    "scopes": ["operator.read", "operator.write"]
  }
}
```

`node.pair.request` 响应：

```json
{
  "type": "res",
  "ok": false,
  "error": { "code": "INVALID_REQUEST", "message": "missing scope: operator.pairing" }
}
```

完整帧记录见 `docs/openclaw-real-smoke-frames.json`（已更新为 R4b 失败时的最新一次捕获）。

### R4b 偏差分析

规格假设 admin token 在 WebSocket 面至少能执行 `node.pair.request`。实测该 gateway 对 shared-secret token 在 WebSocket 面**不授予任何 operator scope**（与 R4 结论一致），因此：

- 请求 `operator.pairing` 不会被服务端采纳；
- `node.pair.request` / `device.pair.request` 均因缺少 scope 被拒绝；
- 拿不到 device operator token，后续重连与 chat 无法继续。

这与 `docs/openclaw-decision-review.md` 修订 1 的预期（shared-secret token 可作为 admin token 完成一次性配对）不符，偏差较大。

## 单轮 chat 事件流

**未产生 provider 可识别的事件流。** `chat.send` 返回 `missing scope: operator.write`，未进入 `ChatChunk` / `ReasoningChunk` / `Done`，无 vault md 落盘。

但服务端确实通过 `agent` 事件向 `agent:main:main` session 输出了 assistant 文本（解释权限问题）。

## 是否通过 R4 / R4b

**均未通过。**

- R4 阻塞：`chat.send` 因缺少 `operator.write` scope 被拒绝；
- R4b 阻塞：`node.pair.request` 因缺少 `operator.pairing` scope 被拒绝，无法获取 device operator token。

两者根因相同：Gray-Cloud gateway 对 shared-secret admin token 在 WebSocket 面**不授予任何 operator scope**。

## 下一步建议

1. **服务端确认**：shared-secret token 在 WebSocket 面是否本应被授予 operator scopes；
2. **HTTP 面替代**：若 WebSocket 面确实不授 scope，是否应通过 HTTP API（决策文档提及 HTTP 面有完整 scope）完成配对，再拿 device token 回 WebSocket 聊天；
3. **凭证升级**：是否需提供另一种 admin token（已带 `operator.admin`/`operator.pairing`）或 OAuth/节点凭证；
4. **agent 事件**：权限解决后，确认 `agent` 事件是否就是真实 chat 的流式响应格式，并在 provider 中保留已新增的映射；
5. 拿到有效 device token 后，重跑 `node scripts/openclaw-pair.mjs ws://100.69.11.71:18789` 完成 R4b 验收。
