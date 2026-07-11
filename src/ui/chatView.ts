import { ItemView, MarkdownRenderer, Notice, WorkspaceLeaf, setIcon } from "obsidian";
import type ZettelkastenAIPlugin from "../main";
import { ChatMessage } from "../providers/types";
import { runAgent, agentSystemPrompt, AgentStep } from "../agent/agent";
import { ToolResult } from "../agent/tools";
import { EFFORTS, EFFORT_ORDER, EffortId } from "../agent/effort";
import { chooseModel, MODELS, ModelChoice } from "../agent/modelRouter";

const MODEL_OPTIONS: { value: ModelChoice; label: string }[] = [
  { value: "auto", label: "Auto" },
  { value: "fast", label: "GLM-4.5-air" },
  { value: "smart", label: "GLM-5.2" },
];

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

const SUGGESTIONS = [
  "Summarize my most-linked notes into a new MOC",
  "What have I concluded about deep work?",
  "Create a note from today's open note's key ideas",
  "Find contradictions across my notes on habits",
];

export class ChatView extends ItemView {
  private history: ChatMessage[] = [];
  private headerEl!: HTMLElement;
  private msgsEl!: HTMLElement;
  private inputEl!: HTMLTextAreaElement;
  private sendBtn!: HTMLButtonElement;
  private abort?: AbortController;
  private running = false;

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

    // ---- header ----
    this.headerEl = root.createDiv({ cls: "zk-header" });
    const title = this.headerEl.createDiv({ cls: "zk-header-title" });
    title.createSpan({ cls: "zk-logo" });
    title.createSpan({ text: "ZettelkastenAI" });

    const actions = this.headerEl.createDiv({ cls: "zk-header-actions" });
    this.buildModelSelector(actions);
    this.buildEffortSelector(actions);
    const newChat = actions.createEl("button", { cls: "clickable-icon zk-icon-btn", attr: { "aria-label": "New chat" } });
    setIcon(newChat, "plus");
    newChat.addEventListener("click", () => this.resetConversation());

    // ---- messages ----
    this.msgsEl = root.createDiv({ cls: "vm-messages" });

    // ---- input ----
    const form = root.createDiv({ cls: "vm-input" });
    this.inputEl = form.createEl("textarea", { attr: { rows: "1", placeholder: "Ask or tell the agent…  (Enter to send)" } });
    this.inputEl.addEventListener("input", () => this.autosize());
    this.inputEl.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        this.running ? this.stop() : void this.send();
      }
    });
    this.sendBtn = form.createEl("button", { cls: "mod-cta zk-send" });
    this.setSendState(false);
    this.sendBtn.addEventListener("click", () => (this.running ? this.stop() : void this.send()));

    this.renderWelcome();
  }

  private modelSelect?: HTMLSelectElement;

  private buildModelSelector(parent: HTMLElement) {
    if (this.plugin.settings.provider !== "hosted") return; // GLM tiers are subscription-only
    const sel = parent.createEl("select", { cls: "dropdown zk-model", attr: { "aria-label": "Model" } });
    for (const o of MODEL_OPTIONS) sel.createEl("option", { value: o.value, text: o.label });
    sel.value = this.plugin.settings.modelChoice;
    sel.title = "Model — Auto picks GLM-4.5-air for simple tasks and GLM-5.2 for hard ones";
    sel.addEventListener("change", async () => {
      this.plugin.settings.modelChoice = sel.value as ModelChoice;
      await this.plugin.saveSettings();
    });
    this.modelSelect = sel;
  }

  private buildEffortSelector(parent: HTMLElement) {
    const sel = parent.createEl("select", { cls: "dropdown zk-effort", attr: { "aria-label": "Effort" } });
    for (const id of EFFORT_ORDER) {
      const o = sel.createEl("option", { value: id, text: EFFORTS[id].label });
      o.title = EFFORTS[id].hint;
    }
    sel.value = this.plugin.settings.effort;
    sel.title = EFFORTS[this.plugin.settings.effort].hint;
    sel.addEventListener("change", async () => {
      this.plugin.settings.effort = sel.value as EffortId;
      sel.title = EFFORTS[sel.value as EffortId].hint;
      await this.plugin.saveSettings();
    });
  }

  private renderWelcome() {
    if (this.msgsEl.childElementCount) return;
    const w = this.msgsEl.createDiv({ cls: "zk-welcome" });
    w.createDiv({ cls: "zk-welcome-title", text: "What should we do in your vault?" });
    w.createDiv({ cls: "zk-welcome-sub", text: "I can search, read, write and reorganize your notes. You approve every change." });
    const chips = w.createDiv({ cls: "zk-suggestions" });
    for (const s of SUGGESTIONS) {
      const chip = chips.createEl("button", { cls: "zk-suggestion", text: s });
      chip.addEventListener("click", () => {
        this.inputEl.value = s;
        this.autosize();
        void this.send();
      });
    }
  }

  private resetConversation() {
    if (this.running) this.stop();
    this.history = [];
    this.msgsEl.empty();
    this.renderWelcome();
    this.inputEl.focus();
  }

  private autosize() {
    this.inputEl.style.height = "auto";
    this.inputEl.style.height = Math.min(this.inputEl.scrollHeight, 160) + "px";
  }

  private setSendState(running: boolean) {
    this.running = running;
    this.sendBtn.empty();
    setIcon(this.sendBtn, running ? "square" : "arrow-up");
    this.sendBtn.setAttr("aria-label", running ? "Stop" : "Send");
  }

  private stop() {
    this.abort?.abort();
    this.setSendState(false);
  }

  private async send() {
    const q = this.inputEl.value.trim();
    if (!q || this.running) return;
    if (q.startsWith("/")) {
      this.inputEl.value = "";
      this.autosize();
      this.handleCommand(q);
      return;
    }
    this.inputEl.value = "";
    this.autosize();
    this.msgsEl.querySelector(".zk-welcome")?.remove();
    this.renderMsg("user", q);

    const s = this.plugin.settings;
    const provider = this.plugin.getProvider();
    this.abort = new AbortController();
    this.setSendState(true);
    try {
      if (s.agentMode && provider.complete) await this.sendAgent(q);
      else await this.sendPlain(q);
    } finally {
      this.setSendState(false);
    }
  }

  private handleCommand(cmd: string) {
    const [name, ...rest] = cmd.slice(1).trim().split(/\s+/);
    const arg = (rest.join(" ") || "").toLowerCase();
    if (name === "model") {
      const map: Record<string, ModelChoice> = { auto: "auto", fast: "fast", air: "fast", "glm-4.5-air": "fast", smart: "smart", "5.2": "smart", "glm-5.2": "smart" };
      if (arg && map[arg]) {
        this.setModel(map[arg]);
        return;
      }
      // no/unknown arg → show a picker
      const wrap = this.msgsEl.createDiv({ cls: "vm-msg vm-assistant zk-cmd" });
      wrap.createDiv({ text: `Model — current: ${this.modelLabel(this.plugin.settings.modelChoice)}. Pick one:` });
      const row = wrap.createDiv({ cls: "zk-cmd-btns" });
      for (const o of MODEL_OPTIONS) {
        const b = row.createEl("button", { text: o.label, cls: o.value === this.plugin.settings.modelChoice ? "mod-cta" : "" });
        b.addEventListener("click", () => this.setModel(o.value));
      }
      this.scroll();
      return;
    }
    if (name === "help") {
      this.renderMsg("assistant", "Commands:\n/model [auto|air|5.2] — choose the model (Auto = GLM-4.5-air for simple tasks, GLM-5.2 for hard ones).");
      return;
    }
    this.renderMsg("assistant", `Unknown command /${name}. Try /model or /help.`);
  }

  private setModel(m: ModelChoice) {
    this.plugin.settings.modelChoice = m;
    void this.plugin.saveSettings();
    if (this.modelSelect) this.modelSelect.value = m;
    this.renderMsg("assistant", `Model set to ${this.modelLabel(m)}.`);
  }

  private modelLabel(m: ModelChoice): string {
    return m === "auto" ? "Auto (air ⇄ 5.2)" : MODELS[m].label;
  }

  private async sendAgent(q: string) {
    const s = this.plugin.settings;
    const effort = EFFORTS[s.effort];
    const provider = this.plugin.getProvider();
    const activePath = this.app.workspace.getActiveFile()?.path;
    const routed = chooseModel(q, s.effort, s.modelChoice);
    // GLM routing only applies to the hosted subscription; Claude Code and BYOK
    // use whatever model the CLI/endpoint is configured with.
    if (s.provider === "hosted") this.renderModelBadge(routed.tier, routed.reason);

    const messages: ChatMessage[] = [
      { role: "system", content: agentSystemPrompt(activePath, effort.directive) },
      ...this.history.slice(-8),
      { role: "user", content: q },
    ];

    const thinking = this.renderThinking();
    let finalEl: HTMLElement | null = null;
    try {
      const finalText = await runAgent(
        provider,
        this.app,
        this.plugin.index,
        messages,
        { autoApprove: s.autoApprove, maxSteps: effort.maxSteps, modelTier: routed.tier, signal: this.abort!.signal },
        {
          onText: (text) => {
            if (!text.trim()) return;
            thinking.hide();
            finalEl = this.msgsEl.createDiv({ cls: "vm-msg vm-assistant" });
            void this.renderMarkdown(text, finalEl);
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
      if (finalEl) this.addCopyButton(finalEl, finalText);
      this.history.push({ role: "user", content: q }, { role: "assistant", content: finalText });
    } catch (e) {
      thinking.remove();
      const msg = e instanceof Error ? e.message : String(e);
      if (!/abort/i.test(msg)) this.renderMsg("assistant", `⚠️ ${msg}`);
    }
  }

  private renderModelBadge(tier: "fast" | "smart", reason: string) {
    const el = this.msgsEl.createDiv({ cls: "vm-step zk-model-badge" });
    const icon = tier === "smart" ? "🧠" : "⚡";
    el.createSpan({ cls: "vm-step-label", text: `${icon} ${MODELS[tier].label} · ${reason}` });
    this.scroll();
  }

  private renderThinking(): HTMLElement {
    const el = this.msgsEl.createDiv({ cls: "vm-msg vm-assistant zk-thinking" });
    el.createSpan({ cls: "zk-dot" });
    el.createSpan({ cls: "zk-dot" });
    el.createSpan({ cls: "zk-dot" });
    this.scroll();
    return el;
  }

  private renderStep(step: AgentStep) {
    const el = this.msgsEl.createDiv({ cls: `vm-step vm-step-${step.status}` });
    const icon = TOOL_ICONS[step.name] ?? "🔧";
    const target = step.args?.path ?? step.args?.query ?? step.args?.folder ?? "";
    const verb = step.status === "rejected" ? "rejected" : step.status === "error" ? "failed" : step.name.replace(/_/g, " ");
    el.createSpan({ cls: "vm-step-label", text: `${icon} ${verb}${target ? " — " + target : ""}` });
    if (step.status === "done" && step.output && step.name.startsWith("search")) {
      const det = el.createEl("details");
      det.createEl("summary", { text: "result" });
      det.createEl("pre", { text: step.output.slice(0, 1200) });
    }
    this.scroll();
  }

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
      btns.createEl("button", { cls: "mod-cta", text: "Approve" }).addEventListener("click", () => done(true));
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
      const hits = this.plugin.index.search(q, EFFORTS[s.effort].topK, active);
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

    const el = this.renderThinking();
    try {
      let acc = "";
      const full = await this.plugin.getProvider().chat({ messages, signal: this.abort!.signal }, (delta) => {
        acc += delta;
        el.removeClass("zk-thinking");
        el.setText(acc);
        this.scroll();
      });
      const md = full + (sources.length ? `\n\n---\nSources: ${sources.map((t) => `[[${t}]]`).join(" · ")}` : "");
      el.removeClass("zk-thinking");
      await this.renderMarkdown(md, el);
      this.addCopyButton(el, full);
      this.history.push({ role: "user", content: q }, { role: "assistant", content: full });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      el.setText(/abort/i.test(msg) ? "⏹ stopped" : `⚠️ ${msg}`);
    }
  }

  private addCopyButton(el: HTMLElement, text: string) {
    const btn = el.createEl("button", { cls: "clickable-icon zk-copy", attr: { "aria-label": "Copy" } });
    setIcon(btn, "copy");
    btn.addEventListener("click", async () => {
      await navigator.clipboard.writeText(text);
      new Notice("Copied");
    });
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
