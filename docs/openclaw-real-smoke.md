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

**握手成功，但 chat.send 被拒绝。**

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
   即 connect 阶段虽然请求了 `operator.read` + `operator.write`，但服务端最终未授予 `operator.write`，导致 chat 方法被拦截。

### 实际发出的 connect JSON（token 已打码）

```json
{
  "type": "req",
  "id": "68ff906c-8a95-473a-9d8c-9edec8b8dd32",
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

### 已尝试的候选微调

按指挥层提示，尝试在 connect params 中：

1. 补 `userAgent: "clarity/1.0.0"`；
2. 去掉 `caps: []`。

微调后的 connect JSON（token 已打码）：

```json
{
  "type": "req",
  "id": "...",
  "method": "connect",
  "params": {
    "minProtocol": 3,
    "maxProtocol": 3,
    "userAgent": "clarity/1.0.0",
    "client": { "id": "cli", "version": "1.0.0", "platform": "linux", "mode": "cli" },
    "role": "operator",
    "scopes": ["operator.read", "operator.write"],
    "auth": { "token": "***" }
  }
}
```

**结果：chat.send 仍报 `missing scope: operator.write`。**

## 协议方言差异

- 真实端仍然使用 clarity-gateway 方言：`connect.challenge` → `req`/`connect` → `hello-ok` → `req`/`chat.send`。
- `simpleConnect` 极简载荷模式未被使用（真实端接受标准 clarity 握手）。
- 当前代码默认 client id = `cli`、scopes = `['operator.read', 'operator.write']`，与服务端握手成功，说明这些字段格式符合真实端预期。
- 差异点：服务端在 hello-ok 后未实际授予 `operator.write`，导致 chat.send 被拒绝。这不是请求格式问题，而是权限/策略问题（token 权限、服务端 scope 校验、或需要额外字段）。

## 代码改动

- `src/openclaw-provider.js`：保留 `simpleConnect` 选项（默认关闭），未启用极简载荷改动；未保留失败的 `userAgent`/`caps` 微调。
- `scripts/openclaw-real-smoke.mjs`：支持命令行或环境变量覆盖 endpoint；增加 WebSocket 发送帧拦截，便于调试（token 自动打码）。
- `test/openclaw-provider.test.js`：同步 provider 当前默认 client id 与 scopes 断言（`gateway-client` → `cli`，`operator.admin` → `operator.write`）。

### 回归验证

```bash
npm test
```

结果：22/22 通过。

## 单轮 chat 事件流

**未产生。** chat.send 在请求阶段即因 scope 校验失败返回错误，未进入 `ChatChunk` / `ReasoningChunk` / `Done` 事件流，无 vault md 落盘。

## 是否通过 R4

**未通过。**

阻塞原因：connect 握手成功，但服务端未授予 `operator.write`，`chat.send` 被以 `missing scope: operator.write` 拒绝。此问题需服务端侧检查 token 权限或 scope 策略，单改客户端请求字段无法绕过。

## 下一步建议

1. 在服务端确认当前 admin token 是否被配置为拥有 `operator.write`；
2. 检查服务端 scope 校验逻辑：是否在 hello-ok 响应中显式返回了 granted scopes，且实际授予集合不包含 `operator.write`；
3. 若服务端要求其他 connect 字段（如 `userAgent` 特定值、client.platform、client.version、role 等），根据服务端日志进一步收窄；
4. 问题解决后重跑 `node scripts/openclaw-real-smoke.mjs ws://100.69.11.71:18789`，验证完整 `connect → chat.send → ChatChunk* → Done → SessionEngine md 落盘` 链路。
