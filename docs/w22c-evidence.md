# W22c 验收证据

## 完成项

### Part 2：obsidian-ai-vault 同步桥
- `src/sync-bridge-manager.js` + `.d.ts`：复用 W20a GatewayManager 生命周期模式（probe → spawn → unload kill）。
- `main.ts`：新增「同步桥」设置区（sync dir、安装目录、salt/state/trash 路径、密码、启用开关、状态灯、日志尾行）。
- `test/sync-bridge-manager.test.js`：6 项测试覆盖锁文件探测、自动拉起失败、状态文本、日志捕获。

### Part 3：文档
- `docs/pc-bridge-setup.md`：官方 Syncthing 一次性配置指南。

### 附带修复（crypto-adapter，W22a 子目录同步缺陷）
- 新增 `join_slash`  helper，替换 `Path::join` 在 Windows 下对含 `/` 的加密相对路径处理错误的问题。
- 修复 `sync_plain_to_enc` 第二遍清理时把含预期文件的父目录一起 `remove_dir_all` 删除的 bug。
- 新增 `test_sync_subdir_roundtrip` 覆盖子目录加密 → 解密往返。

## 测试

```bash
# obsidian-vault-crypto-adapter
cargo test
# test result: ok. 13 passed; 0 failed; 0 ignored

# obsidian-ai-vault
npm test
# tests 58; pass 58; fail 0
```

## 阻塞项

### Part 1：crypto-adapter `watch` 子命令
- 依赖树中**没有 `notify` crate**（`cargo tree | grep notify` 无输出）。
- 按 W22c 纪律未擅自加依赖；`watch` CLI 已添加但当前执行会输出错误并退出：
  ```
  watch subcommand requires the `notify` crate, which is not present in the dependency tree
  ```
- 后续需：在 `obsidian-vault-crypto-adapter/Cargo.toml` 加入 `notify`，然后实现 debouncer + echo 抑制，即可继续 PC ↔ Android 双向 3 轮验收。

## 未能执行的验收

PC ↔ Android 双向 3 轮无 echo 乒乓：因 watch 子命令未真正运行，无法自动触发同步，故未执行。待 notify 加入后可重跑。
