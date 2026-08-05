# W22c 验收证据

## 完成项

### Part 1：crypto-adapter `watch` 子命令
- `Cargo.toml`：新增 `notify` 为可选依赖，`default = ["watch"]`；bridge 侧通过 `default-features = false` 避免把 `notify` 编进 Android。
- `src/main.rs`：实现 `watch` 子命令——同时递归监听 vault 与 sync dir，2s 防抖，每次同步后 3s echo 静默窗口；stderr 输出方向计数；`<state>.lock` 每 5s 刷新 `{pid, ts}` 供 manager 探测。
- 快速冒烟：`vault/Note.md` 创建后 ~2s，`[watch] up +1` 生效，sync dir 出现密文文件。

### Part 2：obsidian-ai-vault 同步桥
- `src/sync-bridge-manager.js` + `.d.ts`：复用 W20a GatewayManager 生命周期模式（probe → spawn → unload kill）。
- `main.ts`：新增「同步桥」设置区（sync dir、安装目录、salt/state/trash 路径、密码、启用开关、状态灯、日志尾行）。
- `test/sync-bridge-manager.test.js`：6 项测试覆盖锁文件探测、自动拉起失败、状态文本、日志捕获。
- 修复：Windows 下 cargo 生成的二进制名为 `obsidian_vault_crypto_adapter.exe`，manager 的 `_binaryPath` 已同步。

### Part 3：文档
- `docs/pc-bridge-setup.md`：官方 Syncthing 一次性配置指南。

### 附带修复（crypto-adapter，W22a 子目录同步缺陷）
- 新增 `join_slash` helper，替换 `Path::join` 在 Windows 下对含 `/` 的加密相对路径处理错误的问题。
- 修复 `sync_plain_to_enc` 第二遍清理时把含预期文件的父目录一起 `remove_dir_all` 删除的 bug。
- 新增 `test_sync_subdir_roundtrip` 覆盖子目录加密 → 解密往返。

## 测试

```bash
# obsidian-vault-crypto-adapter
cargo test
# test result: ok. 13 passed; 0 failed; 0 ignored

cargo build --release
# Finished release profile

# obsidian-ai-vault
npm test
# tests 58; pass 58; fail 0

npm run build
# production build succeeded
```

## 待执行验收

PC ↔ Android 双向 3 轮无 echo 乒乓：watch 子命令已可用，但端到端需要 emulator-5554 设备窗口，当前与 W22b 共用。待 W22b 完成后重跑，并在此文档补充 logcat / sync dir mtime 证据。
