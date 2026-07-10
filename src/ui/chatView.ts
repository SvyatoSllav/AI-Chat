import { ItemView, MarkdownRenderer, WorkspaceLeaf } from "obsidian";
import type ZettelkastenAIPlugin from "../main";
import { ChatMessage } from "../providers/types";
import { runAgent, AGENT_SYSTEM_PROMPT, AgentStep } from "../agent/agent";
import { ToolResult } from "../agent/tools";

export const VIEW_TYPE_CHAT = "zettelkasten-ai-chat";

const TOOL_ICONS: Record<string, string> = {
  search_vault: "🔎",
  list_notes: "📁",
  read_note: "📖",
  get_active_note: "📄",
  create_note: "✨",
  edit_note: "✏️",
  append_note: "➕",
  delete_note: "🗑️",
};

export class ChatView extends ItemView {
  private history: ChatMessage[] = [];
  private msgsEl!: HTMLElement;
  private inputEl!: HTMLTextAreaElement;
  private abort?: AbortController;

  constructor(leaf: WorkspaceLeaf, private plugin: ZettelkastenAIPlugin) {
    super(leaf);
  }

  getViewType() {
    return VIEW_TYPE_CHAT;
  }
  getDisplayText() {
    return "ZettelkastenAI";
  }
  getIcon() {
    return "message-square";
  }

  async onOpen() {
    const root = this.contentEl;
    root.empty();
    root.addClass("zettelkasten-ai");
    this.msgsEl = root.createDiv({ cls: "vm-messages" });
    const form = root.createDiv({ cls: "vm-input" });
    this.inputEl = form.createEl("textarea", {
      attr: { placeholder: "Ask or tell the agent… (Enter — send, Shift+Enter — newline)" },
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
    const provider = this.plugin.getProvider();
    this.abort = new AbortController();

    if (s.agentMode && provider.complete) {
      await this.sendAgent(q);
    } else {
      await this.sendPlain(q);
    }
  }

  private async sendAgent(q: string) {
    const s = this.plugin.settings;
    const provider = this.plugin.getProvider();
    const activePath = this.app.workspace.getActiveFile()?.path;

    const messages: ChatMessage[] = [
      { role: "system", content: AGENT_SYSTEM_PROMPT + (activePath ? `\n\nThe user's currently open note is: ${activePath}` : "") },
      ...this.history.slice(-8),
      { role: "user", content: q },
    ];

    const thinking = this.renderMsg("assistant", "…");
    let lastTextEl: HTMLElement | null = null;

    try {
      const finalText = await runAgent(
        provider,
        this.app,
        this.plugin.index,
        messages,
        { autoApprove: s.autoApprove, maxSteps: s.maxSteps, signal: this.abort!.signal },
        {
          onText: (text) => {
            if (!text.trim()) return;
            thinking.hide();
            lastTextEl = this.msgsEl.createDiv({ cls: "vm-msg vm-assistant" });
            void this.renderMarkdown(text, lastTextEl);
            this.scroll();
          },
          onStep: (step) => {
            thinking.hide();
            this.renderStep(step);
          },
          confirmWrite: (name, args, preview) => this.askApproval(name, args, preview),
        },
      );
      thinking.remove();
      this.history.push({ role: "user", content: q }, { role: "assistant", content: finalText });
    } catch (e) {
      thinking.remove();
      const msg = e instanceof Error ? e.message : String(e);
      if (!/abort/i.test(msg)) this.renderMsg("assistant", `⚠️ ${msg}`);
    }
  }

  private renderStep(step: AgentStep) {
    const el = this.msgsEl.createDiv({ cls: `vm-step vm-step-${step.status}` });
    const icon = TOOL_ICONS[step.name] ?? "🔧";
    const target = step.args?.path ?? step.args?.query ?? step.args?.folder ?? "";
    const verb =
      step.status === "rejected" ? "rejected" : step.status === "error" ? "failed" : step.name.replace(/_/g, " ");
    el.createSpan({ cls: "vm-step-label", text: `${icon} ${verb}${target ? " — " + target : ""}` });
    if (step.status === "done" && step.output && step.name.startsWith("search")) {
      const det = el.createEl("details");
      det.createEl("summary", { text: "result" });
      det.createEl("pre", { text: step.output.slice(0, 1200) });
    }
    this.scroll();
  }

  /** Approval card with a diff; resolves true=approve, false=reject. */
  private askApproval(name: string, args: any, preview: ToolResult["preview"] | null): Promise<boolean> {
    return new Promise((resolve) => {
      const card = this.msgsEl.createDiv({ cls: "vm-approve" });
      const icon = TOOL_ICONS[name] ?? "🔧";
      card.createDiv({ cls: "vm-approve-title", text: `${icon} ${preview?.title ?? name}` });

      if (preview?.after !== undefined || preview?.before !== undefined) {
        const diff = card.createDiv({ cls: "vm-diff" });
        if (name === "edit_note" || name === "append_note") {
          if (preview.before !== undefined) diff.createEl("pre", { cls: "vm-diff-before", text: trunc(preview.before) });
        }
        if (preview.after !== undefined) diff.createEl("pre", { cls: "vm-diff-after", text: trunc(preview.after) });
        else if (name === "delete_note") diff.createEl("pre", { cls: "vm-diff-before", text: "This note will be moved to trash." });
      }

      const btns = card.createDiv({ cls: "vm-approve-btns" });
      const done = (ok: boolean) => {
        btns.remove();
        card.addClass(ok ? "vm-approved" : "vm-rejected");
        card.createSpan({ cls: "vm-approve-verdict", text: ok ? "✓ approved" : "✕ rejected" });
        resolve(ok);
      };
      const approve = btns.createEl("button", { cls: "mod-cta", text: "Approve" });
      approve.addEventListener("click", () => done(true));
      btns.createEl("button", { text: "Reject" }).addEventListener("click", () => done(false));
      this.scroll();
    });
  }

  private async sendPlain(q: string) {
    const s = this.plugin.settings;

    let context = "";
    let sources: string[] = [];
    if (s.vaultQA) {
      const active = this.app.workspace.getActiveFile()?.path;
      const hits = this.plugin.index.search(q, s.topK, active);
      if (s.debugMode && hits.length) {
        this.renderMsg("assistant", "🔎 Debug — retrieved:\n" + hits.map((h, i) => `${i + 1}. ${h.title} (${h.score.toFixed(2)})`).join("\n"));
      }
      if (hits.length === 0 && this.plugin.index.ready) {
        this.renderMsg("assistant", "Nothing in your vault matches this query — try rephrasing it.");
        return;
      }
      context = hits.map((h, i) => `[${i + 1}] from [[${h.title}]]${h.heading ? " — " + h.heading : ""}:\n${h.text}`).join("\n\n");
      sources = [...new Set(hits.map((h) => h.title))];
    }

    const system = [
      "You are ZettelkastenAI, an assistant living inside the user's Obsidian vault.",
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
    try {
      let acc = "";
      const full = await this.plugin.getProvider().chat({ messages, signal: this.abort!.signal }, (delta) => {
        acc += delta;
        el.setText(acc);
        this.scroll();
      });
      el.empty();
      const md = full + (sources.length ? `\n\n---\nSources: ${sources.map((t) => `[[${t}]]`).join(" · ")}` : "");
      await this.renderMarkdown(md, el);
      this.history.push({ role: "user", content: q }, { role: "assistant", content: full });
    } catch (e) {
      el.setText(`⚠️ ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  private async renderMarkdown(md: string, el: HTMLElement) {
    el.empty();
    await MarkdownRenderer.render(this.app, md, el, "", this);
    el.querySelectorAll<HTMLAnchorElement>("a.internal-link").forEach((a) => {
      a.addEventListener("click", (e) => {
        e.preventDefault();
        const target = a.getAttribute("data-href") ?? a.textContent ?? "";
        void this.app.workspace.openLinkText(target, "", false);
      });
    });
  }

  private renderMsg(role: "user" | "assistant", text: string): HTMLElement {
    const wrap = this.msgsEl.createDiv({ cls: `vm-msg vm-${role}` });
    wrap.setText(text);
    this.scroll();
    return wrap;
  }

  private scroll() {
    this.msgsEl.scrollTop = this.msgsEl.scrollHeight;
  }

  async onClose() {
    this.abort?.abort();
  }
}

function trunc(s: string, n = 1400): string {
  return s.length > n ? s.slice(0, n) + `\n… (+${s.length - n} chars)` : s;
}
