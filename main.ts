import {
  App,
  ItemView,
  WorkspaceLeaf,
  Plugin,
  PluginSettingTab,
  Setting,
  TFile,
  MarkdownRenderer,
  Notice,
  TAbstractFile,
} from 'obsidian';
import { SessionEngine } from './src/engine.js';
import { OpenAICompatProvider } from './src/openai-compat-provider.js';
import { GatewayManager } from './src/gateway-manager.js';

const VIEW_TYPE_AI_CHAT = 'ai-vault-chat-view';

interface AiVaultChatSettings {
  gatewayUrl: string;
  model: 'default' | 'expert';
  thinking: boolean;
  search: boolean;
  tokenBudgetChars: number;
  defaultRoute: 'local' | 'openclaw';
  openclawUrl: string;
  openclawToken: string;
  clientId: string;
  peerAgent: 'main' | 'device';
  sessionEntry: 'note' | 'main';
  gatewayInstallDir: string;
  gatewayAutoStart: boolean;
}

const DEFAULT_SETTINGS: AiVaultChatSettings = {
  gatewayUrl: 'http://127.0.0.1:18791',
  model: 'default',
  thinking: false,
  search: true,
  tokenBudgetChars: 12000,
  defaultRoute: 'local',
  openclawUrl: 'http://100.69.11.71:18789',
  openclawToken: '',
  clientId: 'gateway-client',
  peerAgent: 'main',
  sessionEntry: 'note',
  gatewayInstallDir: 'C:/Users/22414/dev/deepseek-device-skill',
  gatewayAutoStart: true,
};

function modelToGatewayModel(model: 'default' | 'expert', route: 'local' | 'openclaw'): string {
  if (route === 'openclaw') {
    return model === 'expert' ? 'openclaw/main' : 'openclaw/default';
  }
  return model === 'expert' ? 'deepseek-reasoner' : 'deepseek-chat';
}

function peerAgentToHeaderId(peerAgent: 'main' | 'device'): string {
  return peerAgent === 'device' ? 'device' : 'gray';
}

function peerAgentDisplay(peerAgent: 'main' | 'device'): string {
  return peerAgent === 'device' ? 'device' : '格雷';
}

function sessionEntryDisplay(entry: 'note' | 'main'): string {
  return entry === 'main' ? '主会话' : '笔记会话';
}

function routeToProvider(route: 'local' | 'openclaw'): 'openai-compat' | 'openclaw' {
  return route === 'openclaw' ? 'openclaw' : 'openai-compat';
}

function urlToPort(url: string, fallback: number): number {
  try {
    const u = new URL(url);
    return parseInt(u.port, 10) || fallback;
  } catch {
    return fallback;
  }
}

// ponytail: vaultIO 直接复用 Obsidian adapter，不做额外缓存或抽象。
function makeVaultIO(adapter: any) {
  return {
    read: async (path: string) => {
      const exists = await adapter.exists(path);
      if (!exists) return '';
      return adapter.read(path);
    },
    write: async (path: string, text: string) => {
      await adapter.write(path, text);
    },
    append: async (path: string, text: string) => {
      const existing = await adapter.exists(path) ? await adapter.read(path) : '';
      await adapter.write(path, existing + text);
    },
    exists: async (path: string) => adapter.exists(path),
    rename: async (oldPath: string, newPath: string) => {
      await adapter.rename(oldPath, newPath);
    },
    mkdir: async (path: string) => {
      if (!(await adapter.exists(path))) {
        await adapter.mkdir(path);
      }
    },
  };
}

class AiVaultChatView extends ItemView {
  plugin: AiVaultChatPlugin;
  private rootEl!: HTMLElement;
  private messagesEl!: HTMLElement;
  private inputEl!: HTMLTextAreaElement;
  private sendBtnEl!: HTMLButtonElement;
  private contextToggleEl!: HTMLInputElement;
  private sessionListEl!: HTMLElement;
  private statusEl!: HTMLElement;
  private routeSelectEl!: HTMLSelectElement;
  private routeBadgeEl!: HTMLElement;
  private identityHeaderEl!: HTMLElement;
  private sessionEntrySelectEl!: HTMLSelectElement;
  private engine: SessionEngine | null = null;
  private currentPath: string | null = null;
  private isStreaming = false;
  private currentRoute: 'local' | 'openclaw';
  private currentSessionEntry: 'note' | 'main';

  constructor(leaf: WorkspaceLeaf, plugin: AiVaultChatPlugin) {
    super(leaf);
    this.plugin = plugin;
    this.currentRoute = plugin.settings.defaultRoute;
    this.currentSessionEntry = plugin.settings.sessionEntry;
  }

  getViewType(): string {
    return VIEW_TYPE_AI_CHAT;
  }

  getDisplayText(): string {
    return 'AI 会话';
  }

  getIcon(): string {
    return 'message-square';
  }

  async onOpen() {
    this.rootEl = this.contentEl.createDiv({ cls: 'ai-vault-chat-container' });
    this.renderLayout();
    await this.loadSessionList();
    this.registerEvent(this.app.vault.on('create', (file: TAbstractFile) => this.onVaultChange(file)));
    this.registerEvent(this.app.vault.on('delete', (file: TAbstractFile) => this.onVaultChange(file)));
    this.registerEvent(this.app.vault.on('rename', (file: TAbstractFile) => this.onVaultChange(file)));
  }

  private onVaultChange(file: TAbstractFile) {
    if (file instanceof TFile && file.path.startsWith('AI 会话/')) {
      this.loadSessionList();
    }
  }

  private renderLayout() {
    this.rootEl.empty();

    // 对侧身份头部
    this.identityHeaderEl = this.rootEl.createEl('div', {
      cls: 'ai-vault-chat-identity',
      text: this.identityText(),
    });

    // 顶部工具栏
    const toolbar = this.rootEl.createDiv({ cls: 'ai-vault-chat-toolbar' });
    toolbar.createEl('button', { text: '新会话', cls: 'ai-vault-chat-btn' }, (btn) => {
      btn.addEventListener('click', () => this.newSession());
    });
    toolbar.createEl('button', { text: '继续当前', cls: 'ai-vault-chat-btn' }, (btn) => {
      btn.addEventListener('click', () => this.resumeCurrent());
    });
    toolbar.createEl('label', { cls: 'ai-vault-chat-context-label' }, (label) => {
      this.contextToggleEl = label.createEl('input', { type: 'checkbox' });
      label.appendText(' 当前笔记作上下文');
    });

    // 路由切换
    toolbar.createEl('div', { cls: 'ai-vault-chat-route' }, (routeWrap) => {
      routeWrap.createEl('span', { text: '路由：', cls: 'ai-vault-chat-route-label' });
      this.routeSelectEl = routeWrap.createEl('select', { cls: 'ai-vault-chat-route-select' });
      this.routeSelectEl.createEl('option', { text: '本地', value: 'local' });
      this.routeSelectEl.createEl('option', { text: 'OpenClaw', value: 'openclaw' });
      this.routeSelectEl.value = this.currentRoute;
      this.routeSelectEl.addEventListener('change', () => this.onRouteChange());
      this.routeBadgeEl = routeWrap.createEl('span', {
        cls: 'ai-vault-chat-route-badge',
        text: this.routeBadgeText(this.currentRoute),
      });
    });

    // 会话入口（仅远程路由可切换；新建会话时生效）
    toolbar.createEl('div', { cls: 'ai-vault-chat-route' }, (entryWrap) => {
      entryWrap.createEl('span', { text: '入口：', cls: 'ai-vault-chat-route-label' });
      this.sessionEntrySelectEl = entryWrap.createEl('select', { cls: 'ai-vault-chat-route-select' });
      this.sessionEntrySelectEl.createEl('option', { text: '笔记会话', value: 'note' });
      this.sessionEntrySelectEl.createEl('option', { text: '主会话挂接', value: 'main' });
      this.sessionEntrySelectEl.value = this.currentSessionEntry;
      this.sessionEntrySelectEl.disabled = this.currentRoute !== 'openclaw';
      this.sessionEntrySelectEl.addEventListener('change', () => this.onSessionEntryChange());
    });

    // 会话列表
    this.sessionListEl = this.rootEl.createDiv({ cls: 'ai-vault-chat-sessions' });

    // 消息区
    this.messagesEl = this.rootEl.createDiv({ cls: 'ai-vault-chat-messages' });

    // 输入区
    const inputArea = this.rootEl.createDiv({ cls: 'ai-vault-chat-input-area' });
    this.inputEl = inputArea.createEl('textarea', {
      cls: 'ai-vault-chat-input',
      attr: { placeholder: '输入消息…', rows: '3' },
    });
    this.sendBtnEl = inputArea.createEl('button', {
      text: '发送',
      cls: 'ai-vault-chat-send-btn',
    });
    this.sendBtnEl.addEventListener('click', () => this.onSend());
    this.inputEl.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        this.onSend();
      }
    });

    // 状态栏
    this.statusEl = this.rootEl.createDiv({ cls: 'ai-vault-chat-status' });
  }

  private async loadSessionList() {
    this.sessionListEl.empty();
    const files = this.app.vault.getFiles()
      .filter((f) => f.path.startsWith('AI 会话/') && f.extension === 'md')
      .sort((a, b) => b.stat.mtime - a.stat.mtime);

    if (files.length === 0) {
      this.sessionListEl.createEl('div', { text: '暂无会话', cls: 'ai-vault-chat-empty' });
      return;
    }

    for (const file of files.slice(0, 20)) {
      const btn = this.sessionListEl.createEl('button', {
        text: file.basename,
        cls: 'ai-vault-chat-session-item',
      });
      btn.addEventListener('click', () => this.loadSession(file.path));
      if (file.path === this.currentPath) {
        btn.addClass('ai-vault-chat-session-active');
      }
    }
  }

  private async loadSession(path: string) {
    this.currentPath = path;
    await this.loadSessionList();
    this.engine = this.createEngine(path);
    await this.renderMessages();
  }

  private newSession() {
    this.currentPath = null;
    this.engine = null;
    this.currentSessionEntry = this.plugin.settings.sessionEntry;
    this.sessionEntrySelectEl.value = this.currentSessionEntry;
    this.updateIdentityHeader();
    this.messagesEl.empty();
    this.setStatus('新会话：输入第一条消息');
  }

  private async resumeCurrent() {
    if (!this.currentPath || !this.engine) {
      new Notice('没有可继续的会话');
      return;
    }
    this.setStatus('处理中断…');
    await this.engine.resume();
    await this.renderMessages();
    this.setStatus('已标记中断');
  }

  private routeBadgeText(route: 'local' | 'openclaw'): string {
    return route === 'openclaw' ? '远程' : '本地';
  }

  private identityText(): string {
    if (this.currentRoute !== 'openclaw') return '本地';
    const peer = peerAgentDisplay(this.plugin.settings.peerAgent);
    const entry = sessionEntryDisplay(this.currentSessionEntry);
    return `远程 · ${peer} · ${entry}`;
  }

  private updateIdentityHeader() {
    if (this.identityHeaderEl) {
      this.identityHeaderEl.textContent = this.identityText();
    }
  }

  private onRouteChange() {
    const route = this.routeSelectEl.value as 'local' | 'openclaw';
    if (route === this.currentRoute) return;
    this.currentRoute = route;
    this.routeBadgeEl.textContent = this.routeBadgeText(route);
    // 本地路由不支持主会话入口
    this.sessionEntrySelectEl.disabled = route !== 'openclaw';
    if (route === 'local') {
      this.currentSessionEntry = 'note';
      this.sessionEntrySelectEl.value = 'note';
    }
    this.updateIdentityHeader();
    // 下一条发送使用新路由；已存在的 engine 保留旧路由，下次发送时重建
    if (!this.isStreaming) {
      this.engine = null;
    }
    this.setStatus(`已切换到 ${this.routeBadgeText(route)} 路由`);
  }

  private onSessionEntryChange() {
    const entry = this.sessionEntrySelectEl.value as 'note' | 'main';
    if (entry === this.currentSessionEntry) return;
    this.currentSessionEntry = entry;
    this.updateIdentityHeader();
    if (!this.isStreaming) {
      this.engine = null;
    }
    this.setStatus(`已切换到 ${sessionEntryDisplay(entry)}`);
  }

  private createEngine(sessionPath: string | null): SessionEngine {
    const vaultIO = makeVaultIO(this.app.vault.adapter);
    const route = this.currentRoute;
    if (route === 'openclaw') {
      if (!this.plugin.settings.openclawUrl || !this.plugin.settings.openclawToken) {
        throw new Error('OpenClaw 路由需要先在设置中填写 URL 和 Token');
      }
    }
    const settings = this.plugin.settings;
    const model = modelToGatewayModel(settings.model, route);
    const tokenBudgetChars = route === 'openclaw' ? 48000 : settings.tokenBudgetChars;
    const peerAgent = route === 'openclaw' ? settings.peerAgent : 'main';
    const sessionEntry = route === 'openclaw' ? this.currentSessionEntry : 'note';

    const engine = new SessionEngine({
      gatewayUrl: settings.gatewayUrl,
      model,
      thinking: settings.thinking,
      search: settings.search,
      vaultIO,
      tokenBudgetChars,
      provider: routeToProvider(route),
      route,
      openclawUrl: settings.openclawUrl,
      openclawToken: settings.openclawToken,
      clientId: settings.clientId,
      sessionEntry,
      peerAgent,
      agentId: peerAgentToHeaderId(peerAgent),
      onEvent: (e: import('./src/engine.js').EngineEvent) => {
        if (e.type === 'user-saved') {
          this.currentPath = e.path || null;
          this.loadSessionList();
          this.renderMessages();
        } else if (e.type === 'content-delta' || e.type === 'think-delta') {
          this.debouncedRender();
        } else if (e.type === 'search-done') {
          this.debouncedRender();
        } else if (e.type === 'turn-done') {
          this.isStreaming = false;
          this.setInputEnabled(true);
          this.setStatus('');
          this.renderMessages();
          this.loadSessionList();
        } else if (e.type === 'error') {
          this.isStreaming = false;
          this.setInputEnabled(true);
          this.setStatus(`错误：${e.error}`);
          new Notice(`AI 会话错误：${e.error}`);
        }
      },
    });
    // 复用已有 sessionId / path，避免继续会话时新建文件
    if (sessionPath) {
      (engine as any).sessionPath = sessionPath;
    }
    return engine;
  }

  private renderTimer: number | null = null;
  private debouncedRender() {
    if (this.renderTimer) window.clearTimeout(this.renderTimer);
    this.renderTimer = window.setTimeout(() => this.renderMessages(), 150);
  }

  private async renderMessages() {
    this.messagesEl.empty();
    if (!this.currentPath) return;
    const text = await this.app.vault.adapter.read(this.currentPath);
    // 渲染整个 md；Obsidian 的 MarkdownRenderer 会处理 callout
    await MarkdownRenderer.render(this.app, text, this.messagesEl, this.currentPath, this);
  }

  private async onSend() {
    const text = this.inputEl.value.trim();
    if (!text) return;
    if (this.isStreaming) return;

    let userText = text;
    if (this.contextToggleEl.checked) {
      const ctx = await this.buildContextSnippet();
      if (ctx) userText = `${ctx}\n\n${text}`;
    }

    this.isStreaming = true;
    this.setInputEnabled(false);
    this.inputEl.value = '';
    this.setStatus('准备 gateway…');

    try {
      if (this.currentRoute === 'local') {
        const ready = await this.plugin.gatewayManager.ensureReady();
        if (!ready.ok) {
          throw new Error(ready.error || '本地 gateway 未就绪');
        }
        if (ready.started) {
          this.setStatus('gateway 已自动拉起，发送中…');
        }
      }
      if (!this.engine) {
        this.engine = this.createEngine(null);
      }
      await this.engine.send(userText);
    } catch (err: any) {
      this.isStreaming = false;
      this.setInputEnabled(true);
      this.setStatus(`错误：${err.message}`);
      new Notice(`发送失败：${err.message}`);
    }
  }

  private async buildContextSnippet(): Promise<string | null> {
    const active = this.app.workspace.getActiveFile();
    if (!active || active.extension !== 'md') return null;
    const content = await this.app.vault.cachedRead(active);
    const max = 4000;
    const body = content.length > max ? `${content.slice(0, max)}…\n（已截断）` : content;
    return `参考笔记《${active.basename}》：\n${body}`;
  }

  private setInputEnabled(enabled: boolean) {
    this.inputEl.disabled = !enabled;
    this.sendBtnEl.disabled = !enabled;
    this.sendBtnEl.textContent = enabled ? '发送' : '生成中…';
  }

  private setStatus(text: string) {
    this.statusEl.textContent = text;
  }
}

class AiVaultChatSettingTab extends PluginSettingTab {
  plugin: AiVaultChatPlugin;

  constructor(app: App, plugin: AiVaultChatPlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();
    containerEl.createEl('h2', { text: 'AI Vault Chat 设置' });

    new Setting(containerEl)
      .setName('Gateway URL')
      .setDesc('本地 deepseek-device-skill 服务地址（本地路由使用）')
      .addText((text) =>
        text
          .setPlaceholder('http://127.0.0.1:18791')
          .setValue(this.plugin.settings.gatewayUrl)
          .onChange(async (value) => {
            this.plugin.settings.gatewayUrl = value;
            this.plugin.gatewayManager = new GatewayManager({
              gatewayUrl: value,
              installDir: this.plugin.settings.gatewayInstallDir,
              port: urlToPort(value, 18791),
              autoStart: this.plugin.settings.gatewayAutoStart,
            });
            await this.plugin.saveSettings();
          })
      );

    containerEl.createEl('h3', { text: '本地 gateway' });
    containerEl.createEl('p', {
      text: '插件在本地路由发送前自动探测并拉起 deepseek-device-skill serve；卸载插件时会自动关闭自己拉起的进程。',
      cls: 'setting-item-description',
    });

    new Setting(containerEl)
      .setName('安装目录')
      .setDesc('deepseek-device-skill 仓库根目录；需要包含 target/release/deepseek-device-skill.exe，且目录下有 dds-cred.txt。')
      .addText((text) =>
        text
          .setPlaceholder('C:/Users/22414/dev/deepseek-device-skill')
          .setValue(this.plugin.settings.gatewayInstallDir)
          .onChange(async (value) => {
            this.plugin.settings.gatewayInstallDir = value;
            this.plugin.gatewayManager = new GatewayManager({
              gatewayUrl: this.plugin.settings.gatewayUrl,
              installDir: value,
              port: urlToPort(this.plugin.settings.gatewayUrl, 18791),
              autoStart: this.plugin.settings.gatewayAutoStart,
            });
            await this.plugin.saveSettings();
          })
      );

    const statusSetting = new Setting(containerEl)
      .setName('状态')
      .setDesc('点击刷新');
    const statusEl = statusSetting.controlEl.createEl('span', {
      text: this.plugin.gatewayManager.statusText(),
      cls: 'ai-vault-gateway-status',
    });
    statusSetting.addButton((btn) =>
      btn.setButtonText('刷新').onClick(async () => {
        await this.plugin.gatewayManager.probe();
        statusEl.textContent = this.plugin.gatewayManager.statusText();
      })
    );

    new Setting(containerEl)
      .setName('随插件自动拉起')
      .setDesc('关闭后，gateway 不可达时将不再自动启动，需手动运行。')
      .addToggle((t) =>
        t.setValue(this.plugin.settings.gatewayAutoStart).onChange(async (value) => {
          this.plugin.settings.gatewayAutoStart = value;
          this.plugin.gatewayManager = new GatewayManager({
            gatewayUrl: this.plugin.settings.gatewayUrl,
            installDir: this.plugin.settings.gatewayInstallDir,
            port: urlToPort(this.plugin.settings.gatewayUrl, 18791),
            autoStart: value,
          });
          await this.plugin.saveSettings();
        })
      );

    containerEl.createEl('h3', { text: '模型路由' });
    containerEl.createEl('p', {
      text: '选择本会话的模型提供商。本地 = 内嵌/本机 DeepSeek gateway；远程 = OpenClaw HTTP 端点（shared-secret token，无需配对）。',
      cls: 'setting-item-description',
    });

    new Setting(containerEl)
      .setName('默认路由')
      .setDesc('新建会话的默认路由')
      .addDropdown((drop) =>
        drop
          .addOption('local', '本地（内嵌 DeepSeek gateway）')
          .addOption('openclaw', 'OpenClaw（远程 agent）')
          .setValue(this.plugin.settings.defaultRoute)
          .onChange(async (value) => {
            this.plugin.settings.defaultRoute = value as 'local' | 'openclaw';
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName('OpenClaw URL')
      .setDesc('OpenClaw HTTP root URL（例如 http://100.69.11.71:18789，不含 /v1）')
      .addText((text) =>
        text
          .setPlaceholder('http://100.69.11.71:18789/v1')
          .setValue(this.plugin.settings.openclawUrl)
          .onChange(async (value) => {
            this.plugin.settings.openclawUrl = value;
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName('OpenClaw Token')
      .setDesc('shared-secret bearer token（从 claw-cred.txt 获取，仅保存在插件 data.json）')
      .addText((text) => {
        text.inputEl.type = 'password';
        text
          .setPlaceholder('')
          .setValue(this.plugin.settings.openclawToken)
          .onChange(async (value) => {
            this.plugin.settings.openclawToken = value;
            await this.plugin.saveSettings();
          });
      });

    new Setting(containerEl)
      .setName('OpenClaw Client ID')
      .setDesc('保留字段，当前 HTTP 面不使用')
      .addText((text) =>
        text
          .setPlaceholder('gateway-client')
          .setValue(this.plugin.settings.clientId)
          .onChange(async (value) => {
            this.plugin.settings.clientId = value;
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName('对侧代理')
      .setDesc('仅 OpenClaw 路由生效。main = 格雷；device = device 身份。')
      .addDropdown((drop) =>
        drop
          .addOption('main', 'main（格雷）')
          .addOption('device', 'device')
          .setValue(this.plugin.settings.peerAgent)
          .onChange(async (value) => {
            this.plugin.settings.peerAgent = value as 'main' | 'device';
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName('默认会话入口')
      .setDesc('仅 OpenClaw 路由生效。笔记会话 = 每个 md 隔离；主会话挂接 = 与 Kimi 客户端共享格雷主会话。')
      .addDropdown((drop) =>
        drop
          .addOption('note', '笔记会话（隔离）')
          .addOption('main', '主会话挂接（与 Kimi 客户端共享）')
          .setValue(this.plugin.settings.sessionEntry)
          .onChange(async (value) => {
            this.plugin.settings.sessionEntry = value as 'note' | 'main';
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName('模型')
      .setDesc('本地：default=deepseek-chat / expert=deepseek-reasoner；OpenClaw：default=openclaw/default / expert=openclaw/main')
      .addDropdown((drop) =>
        drop
          .addOption('default', 'default')
          .addOption('expert', 'expert')
          .setValue(this.plugin.settings.model)
          .onChange(async (value) => {
            this.plugin.settings.model = value as 'default' | 'expert';
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName('Thinking')
      .setDesc('是否输出思考链')
      .addToggle((t) =>
        t.setValue(this.plugin.settings.thinking).onChange(async (value) => {
          this.plugin.settings.thinking = value;
          await this.plugin.saveSettings();
        })
      );

    new Setting(containerEl)
      .setName('Search')
      .setDesc('是否启用联网搜索')
      .addToggle((t) =>
        t.setValue(this.plugin.settings.search).onChange(async (value) => {
          this.plugin.settings.search = value;
          await this.plugin.saveSettings();
        })
      );

    new Setting(containerEl)
      .setName('Token 预算（字符）')
      .setDesc('超出后自动压缩历史会话')
      .addText((text) =>
        text
          .setPlaceholder('12000')
          .setValue(String(this.plugin.settings.tokenBudgetChars))
          .onChange(async (value) => {
            const n = parseInt(value, 10);
            if (!isNaN(n) && n > 0) {
              this.plugin.settings.tokenBudgetChars = n;
              await this.plugin.saveSettings();
            }
          })
      );
  }
}

export default class AiVaultChatPlugin extends Plugin {
  settings!: AiVaultChatSettings;
  gatewayManager!: GatewayManager;

  async onload() {
    await this.loadSettings();

    this.gatewayManager = new GatewayManager({
      gatewayUrl: this.settings.gatewayUrl,
      installDir: this.settings.gatewayInstallDir,
      port: urlToPort(this.settings.gatewayUrl, 18791),
      autoStart: this.settings.gatewayAutoStart,
    });

    this.registerView(VIEW_TYPE_AI_CHAT, (leaf) => new AiVaultChatView(leaf, this));

    this.addRibbonIcon('message-square', 'AI Vault Chat', () => {
      this.activateView();
    });

    this.addCommand({
      id: 'open-ai-vault-chat',
      name: '打开 AI Vault Chat',
      callback: () => this.activateView(),
    });

    this.addSettingTab(new AiVaultChatSettingTab(this.app, this));
  }

  onunload() {
    this.app.workspace.detachLeavesOfType(VIEW_TYPE_AI_CHAT);
    this.gatewayManager?.stop();
  }

  async loadSettings() {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
  }

  async saveSettings() {
    await this.saveData(this.settings);
  }

  async activateView() {
    const { workspace } = this.app;
    let leaf = workspace.getRightLeaf(false);
    if (!leaf) {
      leaf = workspace.getLeaf('split', 'vertical');
    }
    await leaf.setViewState({ type: VIEW_TYPE_AI_CHAT, active: true });
    workspace.revealLeaf(leaf);
  }
}
