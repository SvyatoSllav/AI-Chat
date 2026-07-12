import { App, Notice, Platform, PluginSettingTab, Setting } from "obsidian";
import type AIChatPlugin from "./main";
import { deviceStart, devicePoll, fetchAccount } from "./providers/hosted";

export type ProviderId = "hosted" | "claude-code" | "openai-compatible";

export interface ChatSession {
  id: string;
  name: string;
  createdAt: number;
  updatedAt: number;
  messages: import("./providers/types").ChatMessage[];
}

export interface AIChatSettings {
  onboarded: boolean;
  provider: ProviderId;
  backendUrl: string;
  authEmail: string;
  authToken: string;
  baseUrl: string;
  apiKey: string;
  model: string;
  claudeCodePath: string;
  claudeCodeProxy: string;
  chatTheme: "auto" | "dark" | "light";
  topK: number;
  vaultQA: boolean;
  debugMode: boolean;
  agentMode: boolean;
  autoApprove: boolean;
  maxSteps: number;
  effort: import("./agent/effort").EffortId;
  modelChoice: import("./agent/modelRouter").ModelChoice;
  sessions: ChatSession[];
  activeSessionId: string | null;
}

// Default is the hosted subscription (GLM): sign in with email, 5 messages
// free, then paid. BYOK and Claude Code CLI stay available — see PLAN.md §3, §6.
export const DEFAULT_SETTINGS: AIChatSettings = {
  onboarded: false,
  provider: "hosted",
  backendUrl: "https://zettelkasten-ai.com",
  authEmail: "",
  authToken: "",
  baseUrl: "https://api.deepseek.com/v1",
  apiKey: "",
  model: "deepseek-chat",
  claudeCodePath: "claude",
  claudeCodeProxy: "",
  chatTheme: "auto",
  topK: 8,
  vaultQA: true,
  debugMode: false,
  agentMode: true,
  autoApprove: false,
  maxSteps: 12,
  effort: "medium",
  modelChoice: "auto",
  sessions: [],
  activeSessionId: null,
};

export class AIChatSettingTab extends PluginSettingTab {
  /** Cancels the browser sign-in poll when the tab closes or re-renders. */
  private pollAbort = { cancelled: false };

  constructor(app: App, private plugin: AIChatPlugin) {
    super(app, plugin);
  }

  hide(): void {
    this.pollAbort.cancelled = true;
  }

  display(): void {
    this.pollAbort.cancelled = true;
    this.pollAbort = { cancelled: false };
    const { containerEl } = this;
    containerEl.empty();
    const s = this.plugin.settings;
    const save = () => this.plugin.saveSettings();

    new Setting(containerEl)
      .setName("AI provider")
      .setDesc("AI Chat subscription (no API keys, 5 free messages), your Claude Code CLI, or a self-hosted / own-key endpoint.")
      .addDropdown((d) => {
        d.addOption("hosted", "AI Chat subscription (no keys)");
        if (Platform.isDesktopApp) d.addOption("claude-code", "Claude Code CLI (your Claude account)");
        d.addOption("openai-compatible", "Self-hosted / your own key (OpenAI-compatible)");
        d.setValue(s.provider).onChange(async (v) => {
          s.provider = v as ProviderId;
          await save();
          this.display();
        });
      });

    if (s.provider === "hosted") {
      this.displayAccount(containerEl);
    } else if (s.provider === "openai-compatible") {
      new Setting(containerEl)
        .setName("Preset")
        .setDesc("Quickly fill in the URL and model for a common local provider.")
        .addDropdown((d) => {
          d.addOption("", "— choose preset —");
          d.addOption("ollama", "Ollama (localhost:11434)");
          d.addOption("lmstudio", "LM Studio (localhost:1234)");
          d.addOption("deepseek", "DeepSeek API");
          d.addOption("openrouter", "OpenRouter");
          d.setValue("").onChange(async (v) => {
            if (!v) return;
            const presets: Record<string, { baseUrl: string; model: string; apiKey: string }> = {
              ollama: { baseUrl: "http://localhost:11434/v1", model: "qwen2.5:1.5b", apiKey: "ollama" },
              lmstudio: { baseUrl: "http://localhost:1234/v1", model: "local-model", apiKey: "lm-studio" },
              deepseek: { baseUrl: "https://api.deepseek.com/v1", model: "deepseek-chat", apiKey: "" },
              openrouter: { baseUrl: "https://openrouter.ai/api/v1", model: "meta-llama/llama-3.1-8b-instruct:free", apiKey: "" },
            };
            const p = presets[v];
            if (p) { s.baseUrl = p.baseUrl; s.model = p.model; if (p.apiKey && !s.apiKey) s.apiKey = p.apiKey; await save(); this.display(); }
          });
        });
      new Setting(containerEl).setName("Base URL").addText((t) =>
        t.setValue(s.baseUrl).onChange(async (v) => {
          s.baseUrl = v.trim();
          await save();
        }),
      );
      new Setting(containerEl).setName("API key").setDesc("Leave as 'ollama' for Ollama. Not needed for LM Studio.").addText((t) => {
        t.inputEl.type = "password";
        t.setValue(s.apiKey).onChange(async (v) => {
          s.apiKey = v.trim();
          await save();
        });
      });
      new Setting(containerEl).setName("Model").setDesc("For Ollama: name of the pulled model (e.g. qwen2.5:1.5b). For LM Studio: name shown in the app.").addText((t) =>
        t.setValue(s.model).onChange(async (v) => {
          s.model = v.trim();
          await save();
        }),
      );
    } else {
      new Setting(containerEl)
        .setName("Claude Code binary")
        .setDesc("Path to the official `claude` CLI (default: resolved from PATH). Uses your existing Claude subscription; sign in once with `claude` in a terminal. Desktop only.")
        .addText((t) =>
          t.setValue(s.claudeCodePath).onChange(async (v) => {
            s.claudeCodePath = v.trim() || "claude";
            await save();
          }),
        );
      new Setting(containerEl)
        .setName("HTTP(S) proxy")
        .setDesc("Optional. Forwarded to the claude CLI as HTTPS_PROXY / HTTP_PROXY. Format: http://user:pass@host:port")
        .addText((t) => {
          t.inputEl.style.width = "260px";
          t.setPlaceholder("http://user:pass@host:port")
            .setValue(s.claudeCodeProxy)
            .onChange(async (v) => {
              s.claudeCodeProxy = v.trim();
              await save();
            });
        });
    }

    new Setting(containerEl)
      .setName("Chat theme")
      .setDesc("Auto follows the Obsidian theme; Black / White force one look. Also cycleable from the chat header.")
      .addDropdown((d) =>
        d
          .addOption("auto", "Auto (follow Obsidian)")
          .addOption("dark", "Black")
          .addOption("light", "White")
          .setValue(s.chatTheme)
          .onChange(async (v) => {
            s.chatTheme = v as "auto" | "dark" | "light";
            await save();
          }),
      );

    containerEl.createEl("h3", { text: "Agent" });

    new Setting(containerEl)
      .setName("Agent mode")
      .setDesc("Let the assistant use tools to read, create, edit and delete notes. Works with all providers. Off = plain Q&A over your vault.")
      .addToggle((t) =>
        t.setValue(s.agentMode).onChange(async (v) => {
          s.agentMode = v;
          await save();
          this.display();
        }),
      );

    if (s.agentMode) {
      new Setting(containerEl)
        .setName("Auto-approve file changes")
        .setDesc("On: the agent creates/edits/deletes without asking (full autopilot). Off (recommended): every write shows a diff with Approve/Reject.")
        .addToggle((t) =>
          t.setValue(s.autoApprove).onChange(async (v) => {
            s.autoApprove = v;
            await save();
          }),
        );

      new Setting(containerEl)
        .setName("Max steps per turn")
        .setDesc("Safety cap on tool calls the agent may chain before it must stop.")
        .addSlider((sl) =>
          sl.setLimits(4, 30, 1).setValue(s.maxSteps).setDynamicTooltip().onChange(async (v) => {
            s.maxSteps = v;
            await save();
          }),
        );
    }

    containerEl.createEl("h3", { text: "Retrieval" });

    new Setting(containerEl)
      .setName("Vault QA (RAG)")
      .setDesc("Plain mode only: retrieve relevant notes and ground answers in them with [[wikilink]] citations.")
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

  private displayAccount(containerEl: HTMLElement): void {
    const s = this.plugin.settings;
    const save = () => this.plugin.saveSettings();

    if (!s.authToken) {
      new Setting(containerEl)
        .setName("Account")
        .setDesc("Sign in in your browser — one click, no forms here. 5 messages free, then subscription.")
        .addButton((b) =>
          b.setButtonText("Sign in in browser").setCta().onClick(async () => {
            b.setButtonText("Waiting for sign-in…").setDisabled(true);
            try {
              const { device, url } = await deviceStart(s.backendUrl);
              window.open(url);
              s.authToken = await devicePoll(s.backendUrl, device, 600_000, this.pollAbort);
              await save();
              new Notice("Signed in ✓");
            } catch (e) {
              new Notice(`⚠️ ${e instanceof Error ? e.message : e}`);
            }
            this.display();
          }),
        );
      return;
    }

    const status = new Setting(containerEl).setName("Account").setDesc("Checking account…");
    status.addButton((b) =>
      b.setButtonText("Sign out").onClick(async () => {
        s.authToken = "";
        await save();
        this.display();
      }),
    );
    void fetchAccount(s.backendUrl, s.authToken)
      .then((a) => {
        status.setDesc(
          a.pro
            ? `${a.email} — Pro until ${new Date(a.proUntil!).toLocaleDateString()}`
            : `${a.email} — free messages used: ${a.used}/${a.freeQuota}`,
        );
        if (!a.pro) {
          status.addButton((b) => b.setButtonText("Subscribe").setCta().onClick(() => window.open(a.checkoutUrl)));
        }
      })
      .catch((e) => status.setDesc(`⚠️ ${e instanceof Error ? e.message : e}`));
  }
}
