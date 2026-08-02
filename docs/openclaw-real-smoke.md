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

## 单轮 chat 事件流

**未产生 provider 可识别的事件流。** `chat.send` 返回 `missing scope: operator.write`，未进入 `ChatChunk` / `ReasoningChunk` / `Done`，无 vault md 落盘。

但服务端确实通过 `agent` 事件向 `agent:main:main` session 输出了 assistant 文本（解释权限问题）。

## 是否通过 R4

**未通过。**

阻塞原因：connect 握手成功，hello-ok 未回显 granted scopes；`chat.send` 因服务端未授予 `operator.write` 返回 `INVALID_REQUEST`。客户端请求字段已验证符合 clarity 方言，问题在服务端的 token scope 策略。

## 下一步建议

1. 在服务端确认 shared-secret token 是否本应授予 `operator.write`；
2. 若应授予，检查服务端 scope 授予代码路径（shared-secret 鉴权后是否遗漏 scope 注入）；
3. 若不应授予，确认 WebSocket 聊天应使用哪种认证/授权方式（例如节点配对、设备 token、OAuth 等）；
4. 如决定支持 `agent` 事件作为流式响应，需在 `src/openclaw-provider.js` 的 `_mapEvent` 中增加 `event === 'agent'` 的映射（取 `payload.data.delta` 或 `payload.data.text`）；
5. 权限问题解决后重跑 `node scripts/openclaw-real-smoke.mjs ws://100.69.11.71:18789`，验证完整 `connect → chat.send → 流式事件 → SessionEngine md 落盘` 链路。
