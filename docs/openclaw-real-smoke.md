# OpenClaw 真实 Gateway 冒烟报告（R4）

> 时间：2026-08-02  
> 执行环境：本地 Windows + Git Bash + Node v24.17.0  
> 凭证来源：`claw-cred.txt`（已 gitignore，未提交）

## 真实 Endpoint

```
ws://49.232.19.208:18789
```

> token 已打码，未写入本文档或任何脚本/日志。

## 握手验证结果

**未通过。连接无法建立，不是协议层握手失败，而是网络层端口不可达。**

### 诊断记录

1. **ICMP 可达**：
   ```
   ping -n 3 49.232.19.208
   Reply from 49.232.19.208: bytes=32 time=51ms TTL=97
   Reply from 49.232.19.208: bytes=32 time=50ms TTL=97
   Reply from 49.232.19.208: bytes=32 time=63ms TTL=97
   ```

2. **TCP 18789 不可达**（curl 直接超时）：
   ```
   curl -v --max-time 10 http://49.232.19.208:18789/
   * Connection timed out after 10004 milliseconds
   curl: (28) Connection timed out after 5014/10004 ms
   ```

3. **Python socket connect_ex** 返回 `10035`（非阻塞连接在超时窗口内未完成）。

4. **WebSocket 探测**：
   - `listen` 模式：0 条消息，连接错误。
   - `clarity-connect` 模式：发送 clarity 风格 `connect` req，0 响应，连接错误。
   - `simple-connect` 模式：发送 `{type:'connect', token:'***'}`，0 响应，连接错误。

`claw-cred.txt` 中已注明“内网 `ws://10.209.8.134:18789` 本机不可达，勿用；公网需对方防火墙放通 18789”。当前现象与该注释一致：公网 18789 端口未放通。

## 协议方言差异

**未发现。** 由于 TCP 连接未建立，未能观察到真实 gateway 的任何响应帧，因此无法判断 clarity-gateway 方言与 VPS 真实端之间的协议差异。

## 已做的最小化适配

为在端口放通后能快速验证真实端，已在 `src/openclaw-provider.js` 中增加 `simpleConnect` 选项，允许使用极简 `connect` 载荷：

- 新增构造函数选项 `simpleConnect`（默认 `false`，保持 clarity 方言行为不变）。
- 当 `simpleConnect: true` 时，WebSocket `open` 后立即发送 `{type:'connect', token}`，不再等待 `connect.challenge`。
- hello-ok 等价确认放宽为：原 clarity 的 `res` + `payload.type === 'hello-ok'` 之外，额外接受 `type: 'hello-ok' / 'connected'`、`event: 'hello-ok' / 'connected'`、以及任意 `ok: true` 的 `res`。
- connect 错误识别同步放宽，兼容极简方言可能返回的 `type: 'error'` 或顶层 `error` 字段。

### 改动文件

- `src/openclaw-provider.js`：增加 `simpleConnect` 选项与极简 connect 路径。
- `scripts/openclaw-real-smoke.mjs`：真实 gateway 冒烟脚本（凭证从 `claw-cred.txt` 读取，不硬编码 token）。

### 回归验证

```bash
npm test -- test/openclaw-provider.test.js
```

结果：4/4 通过，clarity mock 行为未受影响。

## 单轮 chat 日志

**未产生。** 连接未建立，无 `ChatChunk` / `ReasoningChunk` / `Done` 事件，无 session key 行为可观察，无 vault md 落盘可检查。

## 是否通过 R4

**未通过。**

阻塞原因：VPS 公网 18789 端口当前未对本次执行环境放通，无法完成 `connect → chat.send → done` 的最小握手与流式验证。

## 下一步建议

1. 协调 Gray-Cloud VPS 管理员放通公网 `49.232.19.208:18789` 的入站 TCP；
2. 端口放通后重跑 `node scripts/openclaw-real-smoke.mjs`（clarity 模式）和 `node scripts/openclaw-real-smoke.mjs simple`（极简模式）；
3. 根据首次成功握手时收到的响应帧，进一步收紧 `_isHelloOk` / `_isConnectError` 的匹配逻辑；
4. 握手成功后，再验证 `ChatChunk` / `ReasoningChunk` / `Done` 语义、`sessionKey` 行为及 `client.id` 白名单影响。
