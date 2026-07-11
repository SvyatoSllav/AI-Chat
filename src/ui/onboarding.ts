import { App, Modal, Platform } from "obsidian";
import type ZettelkastenAIPlugin from "../main";
import type { ProviderId } from "../settings";

/**
 * First-run choice: hosted subscription vs Claude Code CLI vs self-hosted/BYOK.
 * The same choice stays available in Settings → AI provider.
 */
export class OnboardingModal extends Modal {
  constructor(app: App, private plugin: ZettelkastenAIPlugin) {
    super(app);
  }

  onOpen() {
    const { contentEl } = this;
    contentEl.addClass("zk-onboarding");

    contentEl.createEl("h2", { text: "Welcome to ZettelkastenAI" });
    contentEl.createEl("p", {
      cls: "zk-onboard-sub",
      text: "Chat with your vault, let the agent organize your notes. First, pick how the AI runs — you can change this any time in the plugin settings.",
    });

    this.card(
      "hosted",
      "ZettelkastenAI subscription",
      "Recommended",
      [
        "No API keys — sign in with email, 5 free messages to try",
        "GLM 5.2 flagship model, works on desktop and mobile",
        "Fair pricing from $25/mo when you need more",
      ],
      "Use subscription",
    );

    if (Platform.isDesktopApp) {
      this.card(
        "claude-code",
        "Claude Code CLI",
        "Your Claude account",
        [
          "Uses the official `claude` CLI already installed on this machine",
          "Runs on your existing Claude subscription — no extra cost",
          "Desktop only",
        ],
        "Use Claude Code",
      );
    }

    this.card(
      "openai-compatible",
      "Self-hosted / your own key",
      "BYOK",
      [
        "Any OpenAI-compatible endpoint: Ollama, LM Studio, DeepSeek, OpenRouter…",
        "Your key, your costs — requests go straight to your endpoint",
      ],
      "Use my own",
    );
  }

  private card(id: ProviderId, title: string, badge: string, points: string[], cta: string) {
    const card = this.contentEl.createDiv({ cls: "zk-onboard-card" });
    const head = card.createDiv({ cls: "zk-onboard-card-head" });
    head.createSpan({ cls: "zk-onboard-card-title", text: title });
    head.createSpan({ cls: "zk-onboard-badge", text: badge });
    const ul = card.createEl("ul");
    for (const p of points) ul.createEl("li", { text: p });
    const btn = card.createEl("button", { cls: id === "hosted" ? "mod-cta" : "", text: cta });
    btn.addEventListener("click", () => void this.choose(id));
  }

  private async choose(id: ProviderId) {
    const s = this.plugin.settings;
    s.provider = id;
    s.onboarded = true;
    await this.plugin.saveSettings();
    this.close();
    // Finish setup (sign-in / API key / CLI path) in the plugin settings.
    const setting = (this.app as any).setting;
    setting?.open?.();
    setting?.openTabById?.(this.plugin.manifest.id);
  }

  onClose() {
    // Closed without choosing → keep the default, don't nag on next start.
    if (!this.plugin.settings.onboarded) {
      this.plugin.settings.onboarded = true;
      void this.plugin.saveSettings();
    }
    this.contentEl.empty();
  }
}
