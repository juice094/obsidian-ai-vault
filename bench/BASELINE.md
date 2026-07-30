# 性能基线测量报告

> 依据：`docs/PLAN-rust-performance.md` 中 R0 任务包。
> 环境：Node 桌面端先行测量；T5 Android 载体未就绪，故 Android 实测延后，本报告以同一份 JS 引擎在 Node 下的数据作为 go/no-go 代理依据。

## 环境

- CPU: Intel64 Family 6 Model 186 Stepping 2, GenuineIntel
- Node: v24.17.0
- Platform: win32 x64
- 仓库: `obsidian-ai-vault` @ `6520842`
- 测量脚本: `bench/measure.js`
- 测量方法: 每个操作重复 30 次取中位数

## Fixture 规格

| 轮次 | 大小 | 内容 |
| --- | --- | --- |
| 50 | 175.3 KB | 每轮含 user/search/think/正文，正文混合段落、代码块、表格、列表 |
| 200 | 703.8 KB | 同上 |
| 500 | 1763.0 KB | 同上 |

## 测量结果

### parseSession / buildMessages / append+write

| 轮次 | 文件大小 | parseSession | buildMessages | appendTurn+write |
| --- | --- | --- | --- | --- |
| 50 | 175.3 KB | 1.410 ms | 0.019 ms | 0.502 ms |
| 200 | 703.8 KB | 5.164 ms | 0.053 ms | 1.251 ms |
| 500 | 1763.0 KB | 11.182 ms | 0.125 ms | 2.773 ms |

### 流式写盘放大（现状，未批处理）

模拟 2000 字符（100 delta × 20 字符）的流式回复，复用 `engine.js` 现状逻辑：每个 delta 都重写 `prefix + serializeTurn(turnState)`。

| 指标 | 数值 |
| --- | --- |
| delta 数 | 100 |
| 正文实际字符 | 2000 |
| 正文实际字节 | 6000 |
| vaultIO.write 调用次数 | 100 |
| 总写字节 | 715300 |
| **放大系数** | **119.22x** |

## go/no-go 结论

1. **R3 引擎核心 Rust 化**：**NO-GO**。200 轮 `parseSession + buildMessages` 中位数为 **5.217 ms**，远低于 100 ms 门槛。桌面端/同构 JS 引擎没有 parse/build 热点，R3 整个任务包取消。
2. **R1 流式写盘批处理**：**HIGHEST**。现状放大系数 **119.22x**，远超 50x 门槛；100 个 delta 触发 100 次整文件重写，确认是真热点，优先级最高。

## Android 测量说明

T5 Android 载体（魔改 Obsidian APK / WebView 注入）尚未就绪，当前无法在 Android 真机/模拟器上跑同一份 JS 引擎 fixture。由于：
- `parseSession` / `buildMessages` 是纯 JS 计算，桌面 Node 与 Android WebView 均为 V8 家族，量级一致；
- Node 数据已显示 200 轮仅 5 ms，远低于 100 ms 门槛一个数量级；

故 Android 补测不再阻塞 R3 取消决策。若后续 T5 完成需要补录 Android 数字，可直接复用 `bench/measure.js` 在 WebView 环境中执行。

## R1 修复后复测

使用 `src/engine.js` 的批处理实现（150ms / 4KB 缓冲，turn 结束强制 flush），复测同样的 2000 字符 / 100 delta 场景：

| 指标 | 修复前 | 修复后 |
| --- | --- | --- |
| vaultIO.write 调用次数 | 100 | 4 |
| 总写字节 | 715300 | 12949 |
| 放大系数 | **119.22x** | **2.16x** |

满足 R1 验收标准：`write` 次数 ≤ 10，放大系数 < 5x。

## go/no-go 结论（最终）

1. **R3 引擎核心 Rust 化**：**NO-GO**，取消。
2. **R1 流式写盘批处理**：**HIGHEST**，已完成并验证通过。

## 后续动作

- [x] R0 报告产出
- [x] R1 流式写盘批处理（JS）
- [ ] R2 Android 内置 gateway（Rust）
- [x] R3 取消标记（R0 未达标，2026-07-30）
