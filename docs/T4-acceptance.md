# T4 桌面插件人工验收报告（W2）

- **验收对象**：`obsidian-ai-vault` 桌面端 `ai-vault-chat` 插件
- **执行者**：CDP 半自动脚本 `scripts/t4-cdp-acceptance.cjs`
- **执行时间**：2026-07-30
- **前置依赖**：`deepseek-device-skill` gateway（端口 18791，账密来自 `dds-cred.txt`）

---

## 1. 执行摘要

本次验收在修复 `deepseek-device-skill` 的 `dds-cred.txt` 自动读取后，通过 CDP 驱动真实 Obsidian 桌面应用完成。核心流程已跑通：新建会话、expert + 搜索模式聊 2 轮、关闭插件重开续聊、上下文开关切换。发现并记录了 2 项阻断级缺陷和 2 项一般缺陷。

**总体结论：有条件通过，但阻断级缺陷必须修复后重验。**

---

## 2. 环境与前置检查

| 项目 | 状态 | 说明 |
|---|---|---|
| `obsidian-ai-vault` 仓库路径 | 已就绪 | `C:/Users/22414/dev/obsidian-ai-vault` |
| `deepseek-device-skill` 仓库路径 | 已就绪 | `C:/Users/22414/dev/deepseek-device-skill`，`main` 分支 |
| 凭证文件 `dds-cred.txt` | 存在 | 位于 `deepseek-device-skill` 根目录，已按纪律未读取/打印/提交 |
| `DEEPSEEK_DEVICE_TOKEN` | 已 unset | 避免 stale token 覆盖账密 |
| Obsidian 桌面应用 | 已安装 | `C:/Users/22414/AppData/Local/Programs/Obsidian/Obsidian.exe`，以 `--remote-debugging-port=9224` 启动 |
| 测试 vault | 已就绪 | `C:/Users/22414/dev/obsidian-ai-vault/test-vault-t4` |
| 插件产物 | 已部署 | `test-vault-t4/.obsidian/plugins/ai-vault-chat/`（main.js / manifest.json / styles.css） |

---

## 3. 步骤执行记录

### 步骤 1：凭证与 gateway

- **操作**：`unset DEEPSEEK_DEVICE_TOKEN` 后启动 `cargo run -- serve --port 18791`
- **结果**：通过 ✅
- **备注**：`deepseek-device-skill` 已增加当前工作目录 `dds-cred.txt` 自动回读（commit `786804d`）。

### 步骤 2：构建并部署插件

- **操作**：`npm run build`，产物复制到测试 vault
- **结果**：通过 ✅

### 步骤 3：启动 Obsidian 并打开测试 vault

- **操作**：`Obsidian.exe --remote-debugging-port=9224`
- **结果**：通过 ✅，CDP `http://127.0.0.1:9224/json/list` 可连接

### 步骤 4：新建会话聊 2 轮（expert + 搜索）

- **操作**：CDP 调用 `plugin.activateView()`，`view.newSession()`，设置 `plugin.settings.model='expert'`、`search=true`、`thinking=true`，发送两条消息
- **结果**：消息成功发送并落盘，但插件视图消息区为空 ❌（见缺陷 B2）
- **截图**：`docs/T4-screenshots/02-round1-done.png`、`03-round2-done.png`

### 步骤 5：检查 vault md 渲染

- **操作**：CDP 在主区域打开生成的会话 md 并截图
- **结果**：通过 ✅，Obsidian 原生渲染了 frontmatter、user callout、ai 回复、Markdown 表格
- **截图**：`docs/T4-screenshots/03b-md-rendered.png`
- **md 文件**：`docs/T4-screenshots/04-session.md`

### 步骤 6：关闭插件/重开 Obsidian 后续聊

- **操作**：`app.workspace.detachLeavesOfType('ai-vault-chat-view')` 后重新 `activateView()`，再 `loadSession(path)` 发送新消息
- **结果**：通过 ✅
- **截图**：`docs/T4-screenshots/04-resume-done.png`

### 步骤 7：当前笔记作上下文开关

- **操作**：创建 `Context-Note.md` 并在主区域打开，分别切换上下文 chip 开/关后发送消息
- **结果**：通过 ✅
- **截图**：`docs/T4-screenshots/05-context-on.png`、`06-context-off.png`

### 步骤 8：聊天中断 resume

- **操作**：点击插件「继续当前」按钮
- **结果**：按钮可点击，未触发真实 gateway 中断（本次未主动杀掉 gateway）
- **截图**：`docs/T4-screenshots/07-resume-clicked.png`
- **备注**：真实中断场景需人工补测。

---

## 4. 缺陷清单（按严重度分级）

### 阻断级（Blocking）

| # | 缺陷 | 影响 | 证据 |
|---|---|---|---|
| B1 | **`AI 会话/` 目录不存在时发送消息报错 ENOENT**：插件不会自动创建会话目录。 | 新 vault 首次使用必现阻断，必须手动创建 `AI 会话/` 文件夹。 | 脚本首次运行时报错：`ENOENT: no such file or directory, open '...\AI 会话\...'` |
| B2 | **新会话发送后插件视图消息区为空**：`newSession()` 后 `currentPath` 未更新，`renderMessages()` 直接返回，消息内容不显示。 | 用户看不到任何回复，严重损害可用性。 | `02/03-round-done.png` 右侧消息区为空；必须手动 `loadSession(path)` 才能看到内容 |

### 一般级（Minor）

| # | 缺陷 | 影响 | 证据 |
|---|---|---|---|
| M1 | **expert + search 模式下未生成 think/search callout**：实际响应只有正文，无 reasoning 折叠条和 search 折叠条。 | 无法验收 think/search 折叠条渲染。可能是 gateway 未返回 reasoning/search_results，或引擎未处理。 | `04-session.md` 中无 `> [!think]` / `> [!search]`；`03b-md-rendered.png` 中未见对应折叠条 |
| M2 | **会话文件名使用完整 prompt**：如 `2026-07-30 你好，请用一句话介绍自己.md`，过长且包含标点。 | 文件系统兼容性风险，观察不便。 | vault 中实际文件名 |

---

## 5. 截图清单

| 文件 | 说明 |
|---|---|
| `docs/T4-screenshots/01-view-opened.png` | 插件视图初始状态 |
| `docs/T4-screenshots/02-round1-done.png` | 第一轮发送完成（消息区为空） |
| `docs/T4-screenshots/03-round2-done.png` | 第二轮发送完成（消息区为空） |
| `docs/T4-screenshots/03b-md-rendered.png` | 主区域渲染会话 md |
| `docs/T4-screenshots/04-session.md` | 生成的会话 markdown 文本 |
| `docs/T4-screenshots/04-resume-done.png` | 关闭重开后续聊完成 |
| `docs/T4-screenshots/05-context-on.png` | 当前笔记上下文开启 |
| `docs/T4-screenshots/06-context-off.png` | 当前笔记上下文关闭 |
| `docs/T4-screenshots/07-resume-clicked.png` | 点击继续当前按钮 |

---

## 6. 结论与建议

- **验收状态**：**有条件通过**。核心数据链路（插件 → gateway → vault md）已打通，但 2 项阻断级 UI/UX 缺陷必须在进入 W4/W5 前修复。
- **必须修复的阻断缺陷**：
  1. 发送消息前自动创建 `AI 会话/` 目录（若不存在）。
  2. 新会话首条消息发送成功后，插件视图应自动切换到该会话并渲染消息（更新 `currentPath` 并调用渲染）。
- **建议补测**：
  - 真实 gateway 中断后点击 resume，验证 `> [!warning] 本轮中断` 标记。
  - 触发 reasoning/search 响应，验证 think/search callout 渲染。

---

## 7. 纪律声明

- 未查看、打印、提交 `dds-cred.txt` 内容。
- 未在日志、报告、对话输出中暴露任何凭证或 token。
- 测试 vault 与插件产物均位于本地工作目录，未外发。
