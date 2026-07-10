import { App, Platform, PluginSettingTab, Setting } from "obsidian";
import type ZettelkastenAIPlugin from "./main";

export type ProviderId = "claude-code" | "openai-compatible";

export interface ZettelkastenAISettings {
  provider: ProviderId;
  baseUrl: string;
  apiKey: string;
  model: string;
  claudeCodePath: string;
  topK: number;
  vaultQA: boolean;
  debugMode: boolean;
}

// Dev default is Claude Code CLI (desktop). Prod default flips to GLM 5.2
// via backend-issued credentials — see PLAN.md §0 and §3.
export const DEFAULT_SETTINGS: ZettelkastenAISettings = {
  provider: Platform.isDesktopApp ? "claude-code" : "openai-compatible",
  baseUrl: "https://api.deepseek.com/v1",
  apiKey: "",
  model: "deepseek-chat",
  claudeCodePath: "claude",
  topK: 8,
  vaultQA: true,
  debugMode: false,
};

export class ZettelkastenAISettingTab extends PluginSettingTab {
  constructor(app: App, private plugin: ZettelkastenAIPlugin) {
    super(app, plugin);
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();
    const s = this.plugin.settings;
    const save = () => this.plugin.saveSettings();

    new Setting(containerEl)
      .setName("Provider")
      .setDesc("Claude Code — dev default (desktop). OpenAI-compatible covers DeepSeek, OpenRouter, Ollama, Z.ai/GLM.")
      .addDropdown((d) =>
        d
          .addOption("claude-code", "Claude Code CLI (desktop)")
          .addOption("openai-compatible", "OpenAI-compatible endpoint")
          .setValue(s.provider)
          .onChange(async (v) => {
            s.provider = v as ProviderId;
            await save();
            this.display();
          }),
      );

    if (s.provider === "openai-compatible") {
      new Setting(containerEl).setName("Base URL").addText((t) =>
        t.setValue(s.baseUrl).onChange(async (v) => {
          s.baseUrl = v.trim();
          await save();
        }),
      );
      new Setting(containerEl).setName("API key").addText((t) => {
        t.inputEl.type = "password";
        t.setValue(s.apiKey).onChange(async (v) => {
          s.apiKey = v.trim();
          await save();
        });
      });
      new Setting(containerEl).setName("Model").addText((t) =>
        t.setValue(s.model).onChange(async (v) => {
          s.model = v.trim();
          await save();
        }),
      );
    } else {
      new Setting(containerEl)
        .setName("Claude Code binary")
        .setDesc("Path to the official `claude` CLI (default: resolved from PATH).")
        .addText((t) =>
          t.setValue(s.claudeCodePath).onChange(async (v) => {
            s.claudeCodePath = v.trim() || "claude";
            await save();
          }),
        );
    }

    new Setting(containerEl)
      .setName("Vault QA (RAG)")
      .setDesc("Retrieve relevant notes and ground every answer in them, with [[wikilink]] citations.")
      .addToggle((t) =>
        t.setValue(s.vaultQA).onChange(async (v) => {
          s.vaultQA = v;
          await save();
        }),
      );

    new Setting(containerEl)
      .setName("Retrieved chunks (top-k)")
      .addSlider((sl) =>
        sl
          .setLimits(2, 20, 1)
          .setValue(s.topK)
          .setDynamicTooltip()
          .onChange(async (v) => {
            s.topK = v;
            await save();
          }),
      );

    new Setting(containerEl)
      .setName("Debug mode")
      .setDesc("Show retrieved chunks and scores in the chat.")
      .addToggle((t) =>
        t.setValue(s.debugMode).onChange(async (v) => {
          s.debugMode = v;
          await save();
        }),
      );
  }
}
