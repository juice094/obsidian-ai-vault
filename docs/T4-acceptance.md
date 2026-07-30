# T4 桌面插件人工验收报告（W2）

- **验收对象**：`obsidian-ai-vault` 桌面端 `ai-vault-chat` 插件
- **执行者**：AI 子代理（无 GUI 交互与截图能力）
- **执行时间**：2026-07-30
- **前置依赖**：`deepseek-device-skill` gateway（目标端口 18791）

---

## 1. 执行摘要

本次验收尝试按任务步骤推进，但 **在步骤 2（启动 gateway）即被阻断**，且后续所有依赖真实 Obsidian GUI 交互与截图的验收动作均无法由自动化代理完成。报告按实际执行结果记录，未隐瞒阻塞。

**总体结论：不通过（阻断级缺陷/阻塞未清零）。**

---

## 2. 环境与前置检查

| 项目 | 状态 | 说明 |
|---|---|---|
| `obsidian-ai-vault` 仓库路径 | 已就绪 | `C:/Users/22414/dev/obsidian-ai-vault` |
| `deepseek-device-skill` 仓库路径 | 已就绪 | `C:/Users/22414/dev/deepseek-device-skill`，`main` 分支 |
| 凭证文件 `dds-cred.txt` | 存在 | 位于 `deepseek-device-skill` 根目录，大小 22 bytes，已按纪律未读取/打印/提交 |
| `DEEPSEEK_DEVICE_TOKEN` | 已 unset | 避免 stale token 覆盖账密 |
| Obsidian 桌面应用 | 已安装 | `C:/Users/22414/AppData/Local/Programs/Obsidian/Obsidian.exe` |

---

## 3. 步骤执行记录

### 步骤 1：unset `DEEPSEEK_DEVICE_TOKEN`

- **命令**：`unset DEEPSEEK_DEVICE_TOKEN`
- **结果**：通过 ✅
- **备注**：环境变量已清空，避免 token 优先级覆盖账密。

### 步骤 2：启动桌面 gateway

- **任务说明预期**：`cargo run -- serve --port 18791` 会从 `dds-cred.txt` 读取账密。
- **实际执行**：
  ```bash
  cd C:/Users/22414/dev/deepseek-device-skill
  cargo run -- serve --port 18791
  ```
- **实际结果**：编译成功后，gateway 立即退出，报错：
  ```text
  Error: credentials required: provide --token, --token-file, DEEPSEEK_DEVICE_TOKEN, or --mobile + --password
  ```
- **根因**：当前 `deepseek-device-skill` 代码（`src/lib.rs:build_config` 与 `src/main.rs`）**不会自动读取 `dds-cred.txt`**；必须显式传入 `--mobile` + `--password`（或 `--token` / `--token-file` / `DEEPSEEK_DEVICE_TOKEN`）。任务说明与代码实现不一致。
- **结论**：失败 ❌（阻断级）
- **纪律遵守**：未查看 `dds-cred.txt` 内容，因此无法获取手机号/密码来补齐 `--mobile`/`--password` 参数。

### 步骤 3：构建插件并部署到测试 vault

- **命令**：`cd C:/Users/22414/dev/obsidian-ai-vault && npm run build`
- **结果**：通过 ✅
- **产物**：生成 `main.js`（32,839 bytes）、复用 `manifest.json`、`styles.css`。
- **测试 vault**：`C:/Users/22414/dev/obsidian-ai-vault/test-vault-t4`
- **插件安装路径**：`test-vault-t4/.obsidian/plugins/ai-vault-chat/`
  - `main.js` ✅
  - `manifest.json` ✅
  - `styles.css` ✅
- **社区插件注册**：`test-vault-t4/.obsidian/community-plugins.json` 已写入 `["ai-vault-chat"]`。

### 步骤 4：用真实 Obsidian 桌面应用打开测试 vault

- **尝试方法**：
  1. 修改 `%APPDATA%/Obsidian/obsidian.json`，将测试 vault 标记为 `open: true`。
  2. 通过 `cmd.exe /c start "" "%LOCALAPPDATA%\Programs\Obsidian\Obsidian.exe"` 启动 Obsidian。
  3. 创建对应的窗口配置文件 `%APPDATA%/Obsidian/t4testvault00001.json`。
- **结果**：Obsidian 成功启动，并初始化了测试 vault 的 `.obsidian` 配置目录（`app.json`、`appearance.json`、`community-plugins.json`、`core-plugins.json`、`workspace.json`）。✅
- **截图**：无法提供（AI 子代理无截图能力）。

### 步骤 5：验收流程

由于以下原因，**本步骤全部未能执行**：

1. **gateway 未启动**：没有可用的本地 LLM gateway，任何聊天动作都会失败。
2. **无法 GUI 交互**：
   - Obsidian 的 CLI 未启用，无法通过命令行触发插件视图或命令。
   - 尝试通过 Chrome DevTools Protocol（端口 9222/9223）控制 Obsidian 失败：9222 拒绝连接，9223 连接后立即关闭，无法获取页面列表或执行 JS。
   - 因此无法点击"新建会话"、切换 expert/搜索开关、输入消息、验证续聊、触发 resume 等。
3. **无法截图**：AI 子代理没有屏幕截图工具，无法生成每步截图证据。

**未执行子项**：
- 新建会话，聊 2 轮（expert 模式 + 打开搜索）❌
- 检查 vault 中生成的 md 渲染（think/search 折叠条、正文表格/代码块）❌
- 关闭插件/重开 Obsidian 后验证续聊 ❌
- 聊天中途杀掉 gateway 进程，验证 resume（`> [!warning] 本轮中断` 标记）❌
- 「当前笔记作上下文」开关各试一次 ❌

---

## 4. 缺陷清单（按严重度分级）

### 阻断级（Blocking）

| # | 缺陷 | 影响 | 证据 |
|---|---|---|---|
| B1 | **任务说明与代码实现不一致**：`cargo run -- serve --port 18791` 不会自动读取 `dds-cred.txt`，需要额外 `--mobile` + `--password` 参数才能启动。 | 验收流程在步骤 2 即被阻断，无法进入任何需要 gateway 的聊天验证。 | gateway 报错：`credentials required: provide --token, --token-file, DEEPSEEK_DEVICE_TOKEN, or --mobile + --password` |
| B2 | **AI 子代理无法完成 GUI 人工验收**：无法截图、无法通过 CDP/CLI 控制 Obsidian 进行会话创建、发送消息、开关切换等操作。 | 步骤 5 全部子项无法执行，无法收集"通过/失败"的客观证据。 | CDP 端口 9222 拒绝连接；9223 连接后立即关闭；Obsidian CLI 未启用。 |

### 提示级（Informational）

| # | 缺陷/观察 | 说明 |
|---|---|---|
| I1 | `deepseek-device-skill`  Help 输出中 `--token` 默认值暴露了环境变量内容 | 运行 `./target/debug/deepseek-device-skill.exe serve --help` 时，如果 `DEEPSEEK_DEVICE_TOKEN` 已设置，help 文本会显示 token 前缀。本次已提前 unset，未造成泄漏，但属于潜在信息暴露点。 |
| I2 | Obsidian 启动时尝试检查更新失败 | 日志中出现 `Failed to check for update using Github` 与 `Failed to check for update using obsidian.md`，与本次验收无关，但记录了环境网络状态。 |

---

## 5. 结论与建议

- **验收状态**：**不通过**。
- **阻断原因**：
  1. `deepseek-device-skill` gateway 不能按任务说明自动从 `dds-cred.txt` 读取账密，需人工补充 `--mobile`/`--password` 参数或修改代码支持自动读取。
  2. AI 子代理不具备执行真实 Obsidian GUI 验收的能力，需人工接替完成步骤 5 并截图。
- **建议下一步**：
  1. 由掌握 `dds-cred.txt` 内容的人员启动 gateway，命令示例：
     ```bash
     unset DEEPSEEK_DEVICE_TOKEN
     cd C:/Users/22414/dev/deepseek-device-skill
     cargo run -- serve --port 18791 --mobile <手机号> --password <密码>
     ```
  2. 人工在真实 Obsidian 中打开测试 vault `C:/Users/22414/dev/obsidian-ai-vault/test-vault-t4`，启用 `ai-vault-chat` 插件（如提示安全模式则关闭）。
  3. 人工执行步骤 5 的验收子项，并补全截图与每步通过/失败结论。
  4. 若希望后续验收可自动化，建议：
     - 在 `deepseek-device-skill` 中增加 `--cred-file dds-cred.txt` 或自动探测当前目录 `dds-cred.txt` 的能力；
     - 为 Obsidian 启用 CLI（Settings > General > Advanced > Enable command line interface），或提供 REST/CLI 入口供自动化驱动。

---

## 6. 纪律声明

- 未查看、打印、提交 `dds-cred.txt` 内容。
- 未在日志、报告、对话输出中暴露任何凭证或 token。
- 测试 vault 与插件产物均位于本地工作目录，未外发。
