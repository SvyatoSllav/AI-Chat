import { Plugin, TFile, addIcon } from "obsidian";
import { DEFAULT_SETTINGS, AIChatSettings, AIChatSettingTab } from "./settings";
import { VaultIndex } from "./rag/indexer";
import { createProvider } from "./providers";
import { LLMProvider } from "./providers/types";
import { ChatView, VIEW_TYPE_CHAT } from "./ui/chatView";
import { OnboardingModal } from "./ui/onboarding";
import { runBenchmark } from "./benchmark";

// Brand mark (landing/favicon.svg) as a monochrome currentColor icon:
// linked zettel diamonds, no background plate.
const ZK_ICON = `<svg viewBox="0 0 96 96" fill="none" xmlns="http://www.w3.org/2000/svg">
  <g stroke="currentColor" stroke-width="4" opacity=".45">
    <line x1="32" y1="64" x2="60" y2="32"/>
    <line x1="32" y1="64" x2="67" y2="67"/>
    <line x1="60" y1="32" x2="67" y2="67"/>
    <line x1="38" y1="27" x2="60" y2="32" opacity=".6"/>
  </g>
  <rect x="23" y="55" width="18" height="18" fill="currentColor" transform="rotate(45 32 64)"/>
  <rect x="52" y="24" width="16" height="16" fill="currentColor" transform="rotate(45 60 32)"/>
  <rect x="62" y="62" width="10" height="10" fill="currentColor" opacity=".85" transform="rotate(45 67 67)"/>
  <circle cx="38" cy="27" r="3.5" fill="currentColor" opacity=".6"/>
</svg>`;

export default class AIChatPlugin extends Plugin {
  settings!: AIChatSettings;
  index!: VaultIndex;
  private provider: LLMProvider | null = null;
  private statusEl!: HTMLElement;

  async onload() {
    await this.loadSettings();
    addIcon("ai-chat", ZK_ICON);
    this.index = new VaultIndex(this.app);
    this.statusEl = this.addStatusBarItem();

    this.registerView(VIEW_TYPE_CHAT, (leaf) => new ChatView(leaf, this));
    this.addRibbonIcon("ai-chat", "Open AI Chat", () => void this.activateChat());
    this.addCommand({ id: "open-chat", name: "Open chat", callback: () => void this.activateChat() });
    this.addCommand({ id: "reindex", name: "Rebuild vault index", callback: () => void this.buildIndex() });
    this.addCommand({ id: "run-benchmark", name: "Run benchmark", callback: () => void runBenchmark(this.app, this.index, this.settings) });
    this.addSettingTab(new AIChatSettingTab(this.app, this));

    // Index after layout is ready, never at app start (docs/large-vault.md §1)
    this.app.workspace.onLayoutReady(() => {
      if (!this.settings.onboarded) new OnboardingModal(this.app, this).open();
      void this.buildIndex();
      this.registerEvent(
        this.app.vault.on("modify", (f) => {
          if (f instanceof TFile && (f.extension === "md" || f.extension === "pdf")) void this.index.updateFile(f);
        }),
      );
      this.registerEvent(
        this.app.vault.on("create", (f) => {
          if (f instanceof TFile && (f.extension === "md" || f.extension === "pdf")) void this.index.updateFile(f);
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

  async buildIndex() {
    const t0 = Date.now();
    await this.index.build((done, total) => this.statusEl.setText(`AI Chat: indexing ${done}/${total}`));
    this.statusEl.setText(`AI Chat: indexed in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
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
