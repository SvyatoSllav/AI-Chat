import { ItemView, MarkdownRenderer, WorkspaceLeaf } from "obsidian";
import type VaultMindPlugin from "../main";
import { ChatMessage } from "../providers/types";

export const VIEW_TYPE_CHAT = "vaultmind-chat";

export class ChatView extends ItemView {
  private history: ChatMessage[] = [];
  private msgsEl!: HTMLElement;
  private inputEl!: HTMLTextAreaElement;
  private abort?: AbortController;

  constructor(leaf: WorkspaceLeaf, private plugin: VaultMindPlugin) {
    super(leaf);
  }

  getViewType() {
    return VIEW_TYPE_CHAT;
  }
  getDisplayText() {
    return "VaultMind";
  }
  getIcon() {
    return "message-square";
  }

  async onOpen() {
    const root = this.contentEl;
    root.empty();
    root.addClass("vaultmind");
    this.msgsEl = root.createDiv({ cls: "vm-messages" });
    const form = root.createDiv({ cls: "vm-input" });
    this.inputEl = form.createEl("textarea", {
      attr: { placeholder: "Ask your vault… (Enter — send, Shift+Enter — newline)" },
    });
    this.inputEl.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        void this.send();
      }
    });
    form.createEl("button", { text: "Send" }).addEventListener("click", () => void this.send());
  }

  private async send() {
    const q = this.inputEl.value.trim();
    if (!q) return;
    this.inputEl.value = "";
    this.renderMsg("user", q);
    const s = this.plugin.settings;

    // Vault QA retrieval
    let context = "";
    let sources: string[] = [];
    if (s.vaultQA) {
      const active = this.app.workspace.getActiveFile()?.path;
      const hits = this.plugin.index.search(q, s.topK, active);
      if (s.debugMode && hits.length) {
        this.renderMsg(
          "assistant",
          "🔎 Debug — retrieved:\n" + hits.map((h, i) => `${i + 1}. ${h.title} (${h.score.toFixed(2)})`).join("\n"),
        );
      }
      if (hits.length === 0 && this.plugin.index.ready) {
        // docs/large-vault.md §4: empty retrieval → honest answer, no blind LLM call
        this.renderMsg("assistant", "Ничего не нашёл в vault по этому запросу — попробуй переформулировать.");
        return;
      }
      context = hits
        .map((h, i) => `[${i + 1}] from [[${h.title}]]${h.heading ? " — " + h.heading : ""}:\n${h.text}`)
        .join("\n\n");
      sources = [...new Set(hits.map((h) => h.title))];
    }

    const system = [
      "You are VaultMind, an assistant living inside the user's Obsidian vault.",
      context
        ? "Answer ONLY from the provided vault excerpts. Cite sources inline as [[wikilinks]]. If the excerpts do not contain the answer, say so plainly."
        : "Answer helpfully and concisely.",
      context ? `Vault excerpts:\n\n${context}` : "",
    ]
      .filter(Boolean)
      .join("\n\n");

    const messages: ChatMessage[] = [
      { role: "system", content: system },
      ...this.history.slice(-8),
      { role: "user", content: q },
    ];

    const el = this.renderMsg("assistant", "…");
    this.abort = new AbortController();
    try {
      let acc = "";
      const full = await this.plugin.getProvider().chat({ messages, signal: this.abort.signal }, (delta) => {
        acc += delta;
        el.setText(acc);
        this.msgsEl.scrollTop = this.msgsEl.scrollHeight;
      });
      el.empty();
      const md =
        full + (sources.length ? `\n\n---\nSources: ${sources.map((t) => `[[${t}]]`).join(" · ")}` : "");
      await MarkdownRenderer.render(this.app, md, el, "", this);
      this.history.push({ role: "user", content: q }, { role: "assistant", content: full });
    } catch (e) {
      el.setText(`⚠️ ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  private renderMsg(role: "user" | "assistant", text: string): HTMLElement {
    const wrap = this.msgsEl.createDiv({ cls: `vm-msg vm-${role}` });
    wrap.setText(text);
    this.msgsEl.scrollTop = this.msgsEl.scrollHeight;
    return wrap;
  }

  async onClose() {
    this.abort?.abort();
  }
}
