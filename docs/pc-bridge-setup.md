# PC 桥接壳设置指南

本文档说明如何用官方 Syncthing 桌面客户端把 PC 上的 Obsidian vault 与 Android 手机双向同步。W22c 桥接壳负责：

- PC 侧：`obsidian-vault-crypto-adapter watch` 监听 vault 变更并加密到 sync dir，同时监听 sync dir 变更并解密回 vault。
- 传输层：官方 Syncthing（PC ↔ Android）。
- Android 侧：魔改 Obsidian APK 内的 Rust 同步引擎把加密 sync dir 同步回 vault。

> 本指南假设你已经在 PC 上安装好 Obsidian 桌面版与 `obsidian-ai-vault` 插件，并在 Android 模拟器/手机上安装了 W22b 产出的魔改 Obsidian APK。

## 1. 安装官方 Syncthing 桌面版

1. 访问 <https://syncthing.net/downloads/>，下载 Windows 安装包。
2. 按向导完成安装；安装程序会自动把 Syncthing 注册为系统服务并在浏览器打开 Web GUI（默认 `http://127.0.0.1:8384`）。
3. 建议勾选「开机启动」，这样 sync dir 的同步在日常使用中零手动。

## 2. 获取 Android 设备 ID

1. 在 emulator-5554（或手机）上启动魔改 Obsidian。
2. 插件设置页或 logcat 会显示当前设备 ID，形如 `ABCDE1-FGHIJ2-KLMNO3-PQRST4-UVWXY5-ZABCD6-EFGHI7-JKLMN8`。
3. 复制这串 ID，稍后添加给 PC 端。

## 3. 配置 Syncthing Folder

在 PC 端 Web GUI 中：

1. 点击「添加文件夹」。
2. **文件夹 ID**：填写一个稳定标识，例如 `obsidian-vault-sync`。
3. **文件夹路径**：选择插件设置里填写的「Sync dir 路径」（加密侧目录）。
4. **文件夹类型**：保持默认 `Send & Receive`。
5. **共享**：勾选 Android 设备。
6. 点击「保存」。

## 4. 添加 Android 设备

1. 在 PC 端 Web GUI 点击「添加远程设备」。
2. **设备 ID**：粘贴第 2 步复制的 Android 设备 ID。
3. **设备名**：可自定义，例如 `Pixel-7-Obsidian`。
4. **共享**：勾选刚才创建的 folder `obsidian-vault-sync`。
5. 点击「保存」。

Android 端 Syncthing-Fork（或魔改 APK 内 Rust 引擎）在收到连接请求后确认配对，即可开始同步。

## 5. 启用插件同步桥

1. 打开 Obsidian 设置 → 社区插件 → AI Vault Chat → 同步桥。
2. 填写：
   - **crypto-adapter 安装目录**：`C:/Users/22414/dev/obsidian-vault-crypto-adapter`
   - **Sync dir 路径**：与 Syncthing folder 路径一致
   - **Salt 文件路径**：vault 对应的 salt 文件（可放在 sync dir 同级或安全位置）
   - **Vault 密码**：vault 加密密码
   - **状态文件路径**：留空则自动使用插件目录（`vault/.obsidian/plugins/ai-vault-chat/sync-bridge-state.json`）
   - **Trash 路径**：留空则使用默认值
3. 打开「启用同步桥」。
4. 状态灯变绿表示 `watch` 进程已就绪，日志区会显示最近一次同步结果。

## 6. 验证双向同步

执行 3 轮双向修改，确认 sync dir 中同一文件的 mtime 不会被反复刷新（无 echo 乒乓）：

1. **PC → Android**：在 PC Obsidian 新建/修改笔记，等待状态灯日志刷新 → 在 Android 魔改 Obsidian 中查看同一笔记内容一致。
2. **Android → PC**：在 Android 修改笔记 → 等待 Syncthing 同步完成 → 在 PC Obsidian 查看内容一致。
3. 重复 3 轮。

判断无 echo 的方法：观察 sync dir 中任意加密文件的修改时间，在双向同步稳定后应不再变化；`watch` 日志应只显示 `unchanged`。

## 7. 日常使用纪律

- **不要同时双端编辑同一文件**：Syncthing 会把冲突生成 `.sync-conflict-...` 副本，虽然不会丢数据，但会增加手动合并成本。
- **状态文件与 trash 目录必须在 sync dir 之外**，否则会被 Syncthing 传播或触发不必要的同步。
- 首次启用前建议先手动备份 vault。
- 若状态灯变红，检查：
  - `obsidian-vault-crypto-adapter/target/release/obsidian-vault-crypto-adapter.exe` 是否存在（需 `cargo build --release`）
  - salt 文件、sync dir、state/trash 路径是否可写
  - 插件日志区最后一条 stderr 输出

## 8. 故障排查

| 现象 | 排查方向 |
|---|---|
| 状态灯一直黄 | watch 进程启动中或无法创建锁文件；检查路径权限。 |
| 状态灯红 | 二进制缺失、参数错误、或 watch 异常退出；看日志区。 |
| PC 改完手机看不到 | Syncthing 尚未连接；检查 Android 设备在线状态。 |
| 手机改完 PC 看不到 | Syncthing 已同步但 watch 未触发；手动点设置页「刷新」。 |
| 同一文件反复同步 | echo 乒乓；确认 state 文件在 sync dir 外且 watch 已读取。 |
