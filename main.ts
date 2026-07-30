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

const VIEW_TYPE_AI_CHAT = 'ai-vault-chat-view';

interface AiVaultChatSettings {
  gatewayUrl: string;
  model: 'default' | 'expert';
  thinking: boolean;
  search: boolean;
  tokenBudgetChars: number;
}

const DEFAULT_SETTINGS: AiVaultChatSettings = {
  gatewayUrl: 'http://127.0.0.1:18791',
  model: 'default',
  thinking: false,
  search: true,
  tokenBudgetChars: 12000,
};

function modelToGatewayModel(model: 'default' | 'expert'): string {
  return model === 'expert' ? 'deepseek-reasoner' : 'deepseek-chat';
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
  private engine: SessionEngine | null = null;
  private currentPath: string | null = null;
  private isStreaming = false;

  constructor(leaf: WorkspaceLeaf, plugin: AiVaultChatPlugin) {
    super(leaf);
    this.plugin = plugin;
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

  private createEngine(sessionPath: string | null): SessionEngine {
    const vaultIO = makeVaultIO(this.app.vault.adapter);
    const engine = new SessionEngine({
      gatewayUrl: this.plugin.settings.gatewayUrl,
      model: modelToGatewayModel(this.plugin.settings.model),
      thinking: this.plugin.settings.thinking,
      search: this.plugin.settings.search,
      vaultIO,
      tokenBudgetChars: this.plugin.settings.tokenBudgetChars,
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
    this.setStatus('思考中…');

    try {
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
      .setDesc('本地 deepseek-device-skill 服务地址')
      .addText((text) =>
        text
          .setPlaceholder('http://127.0.0.1:18791')
          .setValue(this.plugin.settings.gatewayUrl)
          .onChange(async (value) => {
            this.plugin.settings.gatewayUrl = value;
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName('模型')
      .setDesc('default = deepseek-chat，expert = deepseek-reasoner（深度思考）')
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

  async onload() {
    await this.loadSettings();

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
