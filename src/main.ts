import { Plugin, TFile } from "obsidian";
import { DEFAULT_SETTINGS, ZettelkastenAISettings, ZettelkastenAISettingTab } from "./settings";
import { VaultIndex } from "./rag/indexer";
import { createProvider } from "./providers";
import { LLMProvider } from "./providers/types";
import { ChatView, VIEW_TYPE_CHAT } from "./ui/chatView";

export default class ZettelkastenAIPlugin extends Plugin {
  settings!: ZettelkastenAISettings;
  index!: VaultIndex;
  private provider: LLMProvider | null = null;
  private statusEl!: HTMLElement;

  async onload() {
    await this.loadSettings();
    this.index = new VaultIndex(this.app);
    this.statusEl = this.addStatusBarItem();

    this.registerView(VIEW_TYPE_CHAT, (leaf) => new ChatView(leaf, this));
    this.addRibbonIcon("message-square", "Open ZettelkastenAI chat", () => void this.activateChat());
    this.addCommand({ id: "open-chat", name: "Open chat", callback: () => void this.activateChat() });
    this.addCommand({ id: "reindex", name: "Rebuild vault index", callback: () => void this.buildIndex() });
    this.addSettingTab(new ZettelkastenAISettingTab(this.app, this));

    // Index after layout is ready, never at app start (docs/large-vault.md §1)
    this.app.workspace.onLayoutReady(() => {
      void this.buildIndex();
      this.registerEvent(
        this.app.vault.on("modify", (f) => {
          if (f instanceof TFile && f.extension === "md") void this.index.updateFile(f);
        }),
      );
      this.registerEvent(
        this.app.vault.on("create", (f) => {
          if (f instanceof TFile && f.extension === "md") void this.index.updateFile(f);
        }),
      );
      this.registerEvent(
        this.app.vault.on("delete", (f) => {
          if (f instanceof TFile) this.index.removePath(f.path);
        }),
      );
      this.registerEvent(
        this.app.vault.on("rename", (f, old) => {
          if (f instanceof TFile && f.extension === "md") void this.index.renamePath(f, old);
        }),
      );
    });
  }

  private async buildIndex() {
    const t0 = Date.now();
    await this.index.build((done, total) => this.statusEl.setText(`ZettelkastenAI: indexing ${done}/${total}`));
    this.statusEl.setText(`ZettelkastenAI: indexed in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
    window.setTimeout(() => this.statusEl.setText(""), 5000);
  }

  getProvider(): LLMProvider {
    if (!this.provider) this.provider = createProvider(this.settings);
    return this.provider;
  }

  async activateChat() {
    const { workspace } = this.app;
    let leaf = workspace.getLeavesOfType(VIEW_TYPE_CHAT)[0];
    if (!leaf) {
      leaf = workspace.getRightLeaf(false)!;
      await leaf.setViewState({ type: VIEW_TYPE_CHAT, active: true });
    }
    void workspace.revealLeaf(leaf);
  }

  async loadSettings() {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
  }

  async saveSettings() {
    await this.saveData(this.settings);
    this.provider = null; // recreate with new settings on next use
  }
}
