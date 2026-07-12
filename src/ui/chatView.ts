import { ItemView, MarkdownRenderer, Notice, WorkspaceLeaf, setIcon } from "obsidian";
import type AIChatPlugin from "../main";
import { ChatMessage } from "../providers/types";
import { ChatSession } from "../settings";
import { runAgent, agentSystemPrompt, AgentStep } from "../agent/agent";
import { ToolResult } from "../agent/tools";
import { EFFORTS, EFFORT_ORDER, EffortId } from "../agent/effort";
import { chooseModel, ModelChoice, LITE_MODELS, MODEL_BY_ID, modelLabel } from "../agent/modelRouter";
import { fetchAccount } from "../providers/hosted";

const MODEL_OPTIONS: { value: ModelChoice; label: string }[] = [
  { value: "auto", label: "Auto (air ⇄ 5.2)" },
  ...LITE_MODELS.map((m) => ({ value: m.id, label: m.label })),
];

export const VIEW_TYPE_CHAT = "ai-chat";

// lucide icon per agent tool
const TOOL_ICONS: Record<string, string> = {
  search_vault: "search",
  list_notes: "folder-open",
  read_note: "book-open",
  get_active_note: "file-text",
  create_note: "file-plus",
  edit_note: "pencil-line",
  append_note: "list-plus",
  delete_note: "trash-2",
};

interface PaletteCommand {
  group: string;
  icon: string;
  title: string;
  sub: string;
  run: () => void;
}

export class ChatView extends ItemView {
  private history: ChatMessage[] = [];
  private headerEl!: HTMLElement;
  private msgsEl!: HTMLElement;
  private inputEl!: HTMLTextAreaElement;
  private sendBtn!: HTMLButtonElement;
  private abort?: AbortController;
  private running = false;
  /** undefined = follow the active note; null = user dismissed the context chip. */
  private contextPath: string | null | undefined = undefined;
  private ctxRowEl?: HTMLElement;
  private paletteEl?: HTMLElement;
  private paletteVisible = false;
  private paletteIndex = 0;
  private paletteItems: { el: HTMLElement; run: () => void }[] = [];
  private sessionsBtnEl?: HTMLButtonElement;
  private sessionsDropEl?: HTMLElement;

  constructor(leaf: WorkspaceLeaf, private plugin: AIChatPlugin) {
    super(leaf);
  }

  getViewType() {
    return VIEW_TYPE_CHAT;
  }
  getDisplayText() {
    return "AI Chat";
  }
  getIcon() {
    return "ai-chat";
  }

  async onOpen() {
    const root = this.contentEl;
    root.empty();
    root.addClass("ai-chat");
    this.applyTheme();

    // ---- top bar ----
    this.headerEl = root.createDiv({ cls: "zk-tabbar" });
    this.headerEl.createDiv({ cls: "zk-title", text: "AI Chat" });

    const actions = this.headerEl.createDiv({ cls: "zk-actions" });
    const themeBtn = actions.createEl("button", { cls: "clickable-icon zk-icon-btn" });
    const paintThemeIcon = () => {
      const t = this.plugin.settings.chatTheme;
      setIcon(themeBtn, t === "auto" ? "sun-moon" : t === "dark" ? "moon" : "sun");
      themeBtn.setAttr("aria-label", `Theme: ${t === "auto" ? "auto (follows Obsidian)" : t === "dark" ? "black" : "white"}`);
    };
    paintThemeIcon();
    themeBtn.addEventListener("click", async () => {
      const s = this.plugin.settings;
      // Always toggle based on what's currently visible — avoids the "no-change"
      // click that happens when auto matches the direction you want to switch to.
      const currentlyDark = this.contentEl.classList.contains("zk-dark");
      s.chatTheme = currentlyDark ? "light" : "dark";
      await this.plugin.saveSettings();
      this.applyTheme();
      paintThemeIcon();
    });
    this.registerEvent(this.app.workspace.on("css-change", () => this.applyTheme()));

    const settingsBtn = actions.createEl("button", { cls: "clickable-icon zk-icon-btn", attr: { "aria-label": "Settings" } });
    setIcon(settingsBtn, "settings");
    settingsBtn.addEventListener("click", () => this.openSettings());

    // sessions button
    this.sessionsBtnEl = actions.createEl("button", { cls: "clickable-icon zk-icon-btn", attr: { "aria-label": "Chat history" } });
    setIcon(this.sessionsBtnEl, "history");
    this.sessionsDropEl = actions.createDiv({ cls: "zk-sessions-drop" });
    this.sessionsDropEl.hide();
    this.sessionsBtnEl.addEventListener("click", (e) => { e.stopPropagation(); this.toggleSessionsDrop(); });
    document.addEventListener("click", () => this.sessionsDropEl?.hide(), { capture: true });

    const newChat = actions.createEl("button", { cls: "clickable-icon zk-icon-btn", attr: { "aria-label": "New chat" } });
    setIcon(newChat, "plus");
    newChat.addEventListener("click", () => this.newSession());

    // ---- messages ----
    this.msgsEl = root.createDiv({ cls: "vm-messages" });

    // ---- input area (context chip row + textarea + toolbar) ----
    const inputWrap = root.createDiv({ cls: "zk-inputwrap" });
    this.paletteEl = inputWrap.createDiv({ cls: "zk-palette" });
    this.paletteEl.hide();

    const card = inputWrap.createDiv({ cls: "zk-inputcard" });
    this.ctxRowEl = card.createDiv({ cls: "zk-ctxrow" });
    this.renderContextChip();
    this.registerEvent(
      this.app.workspace.on("active-leaf-change", () => {
        this.contextPath = undefined; // a new note re-enters the context
        this.renderContextChip();
      }),
    );

    this.inputEl = card.createEl("textarea", { attr: { rows: "1", placeholder: "Ask your vault…  ( / for commands )" } });
    this.inputEl.addEventListener("input", () => {
      this.autosize();
      this.updatePalette();
    });
    this.inputEl.addEventListener("keydown", (e) => {
      if (this.paletteVisible) {
        if (e.key === "ArrowDown") { e.preventDefault(); this.movePalette(1); return; }
        if (e.key === "ArrowUp") { e.preventDefault(); this.movePalette(-1); return; }
        if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); this.paletteItems[this.paletteIndex]?.run(); return; }
        if (e.key === "Escape") { this.hidePalette(); return; }
      }
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        this.running ? this.stop() : void this.send();
      }
    });

    const bar = card.createDiv({ cls: "zk-toolbar" });
    this.buildEffortSelector(bar);
    this.buildModelSelector(bar);
    bar.createDiv({ cls: "zk-toolbar-spacer" });
    this.sendBtn = bar.createEl("button", { cls: "zk-send" });
    this.setSendState(false);
    this.sendBtn.addEventListener("click", () => (this.running ? this.stop() : void this.send()));

    // ---- footer ----
    void this.buildFooter(root);

    // Restore active session if one exists
    const activeSess = this.plugin.settings.sessions.find((s) => s.id === this.plugin.settings.activeSessionId);
    if (activeSess?.messages.length) {
      this.history = [...activeSess.messages];
      for (const msg of this.history) {
        if (msg.role === "user") this.renderMsg("user", typeof msg.content === "string" ? msg.content : "");
        else if (msg.role === "assistant" && msg.content) {
          const { body } = this.renderAssistantBlock(false);
          void this.renderMarkdown(typeof msg.content === "string" ? msg.content : "", body);
        }
      }
    } else {
      this.renderWelcome();
    }
  }

  private applyTheme() {
    const t = this.plugin.settings.chatTheme;
    const dark = t === "auto" ? document.body.classList.contains("theme-dark") : t === "dark";
    this.contentEl.toggleClass("zk-dark", dark);
    this.contentEl.toggleClass("zk-light", !dark);
  }

  private openSettings() {
    const setting = (this.app as any).setting;
    setting?.open?.();
    setting?.openTabById?.(this.plugin.manifest.id);
  }

  private async buildFooter(root: HTMLElement) {
    const s = this.plugin.settings;
    const el = root.createDiv({ cls: "zk-footer" });
    const left = el.createSpan();
    el.createSpan({ cls: "zk-footer-right", text: "↵ send · ⇧↵ new line" });

    if (s.provider === "claude-code") {
      left.setText(`Claude Code CLI${s.claudeCodeProxy ? " · proxy on" : ""}`);
      return;
    }
    if (s.provider === "openai-compatible") {
      left.setText(s.model || "Custom endpoint");
      return;
    }
    left.setText("AI Chat");
    if (!s.authToken) return;
    try {
      const a = await fetchAccount(s.backendUrl, s.authToken);
      left.setText(a.pro ? `Pro · renews ${new Date(a.proUntil!).toLocaleDateString()}` : `Usage: ${a.used}/${a.freeQuota} free`);
    } catch {
      /* keep the plain label */
    }
  }

  // ---------- context chip ----------

  private renderContextChip() {
    const row = this.ctxRowEl;
    if (!row) return;
    row.empty();
    const file = this.app.workspace.getActiveFile();
    if (!file || this.contextPath === null) {
      row.hide();
      return;
    }
    row.show();
    const ic = row.createSpan({ cls: "zk-ctx-icon" });
    setIcon(ic, "file-text");
    row.createSpan({ cls: "zk-ctx-name", text: file.basename });
    const x = row.createEl("button", { cls: "zk-ctx-x", attr: { "aria-label": "Remove note from context" } });
    setIcon(x, "x");
    x.addEventListener("click", () => {
      this.contextPath = null;
      this.renderContextChip();
    });
  }

  /** Active note path, unless the user dismissed the context chip. */
  private activeContextPath(): string | undefined {
    if (this.contextPath === null) return undefined;
    return this.app.workspace.getActiveFile()?.path;
  }

  // ---------- toolbar selectors ----------

  private modelSelect?: HTMLSelectElement;
  private effortSelect?: HTMLSelectElement;

  private buildModelSelector(parent: HTMLElement) {
    if (this.plugin.settings.provider !== "hosted") return; // GLM tiers are subscription-only
    const sel = parent.createEl("select", { cls: "zk-select", attr: { "aria-label": "Model" } });
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
    const sel = parent.createEl("select", { cls: "zk-select", attr: { "aria-label": "Effort" } });
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
    this.effortSelect = sel;
  }

  private setModel(m: ModelChoice) {
    this.plugin.settings.modelChoice = m;
    void this.plugin.saveSettings();
    if (this.modelSelect) this.modelSelect.value = m;
  }

  private setEffort(id: EffortId) {
    this.plugin.settings.effort = id;
    void this.plugin.saveSettings();
    if (this.effortSelect) {
      this.effortSelect.value = id;
      this.effortSelect.title = EFFORTS[id].hint;
    }
  }

  private modelLabel(m: ModelChoice): string {
    return modelLabel(m);
  }

  // ---------- welcome / quick actions ----------

  private quickActions(): PaletteCommand[] {
    const active = this.app.workspace.getActiveFile();
    const acts: PaletteCommand[] = [];
    if (active) {
      acts.push({
        group: "Quick actions",
        icon: "align-left",
        title: "Summarize active note",
        sub: `"${active.basename}"`,
        run: () => this.sendPreset(`Summarize [[${active.basename}]] into its key points.`),
      });
    }
    acts.push({
      group: "Quick actions",
      icon: "git-fork",
      title: "Find related concepts",
      sub: active ? `Connections for "${active.basename}"` : "Explore semantic links in vault",
      run: () =>
        this.sendPreset(
          active
            ? `Find notes related to [[${active.basename}]] and explain how they connect.`
            : "Find clusters of closely related notes in my vault and explain the connections.",
        ),
    });
    acts.push({
      group: "Quick actions",
      icon: "lightbulb",
      title: "Brainstorm next steps",
      sub: "Generate ideas from current context",
      run: () => this.sendPreset("Based on my current note and the notes related to it, brainstorm concrete next steps."),
    });
    return acts;
  }

  private renderWelcome() {
    if (this.msgsEl.childElementCount) return;
    const w = this.msgsEl.createDiv({ cls: "zk-welcome" });
    const badge = w.createDiv({ cls: "zk-welcome-badge" });
    setIcon(badge, "ai-chat");
    w.createDiv({ cls: "zk-welcome-title", text: "How can I help in your vault?" });
    w.createDiv({
      cls: "zk-welcome-sub",
      text: "I'm connected to your notes. Ask a question, or use a quick action on your current note.",
    });
    const grid = w.createDiv({ cls: "zk-qa" });
    for (const a of this.quickActions()) {
      const card = grid.createEl("button", { cls: "zk-qa-card" });
      const ic = card.createSpan({ cls: "zk-qa-icon" });
      setIcon(ic, a.icon);
      const col = card.createDiv({ cls: "zk-qa-text" });
      col.createDiv({ cls: "zk-qa-title", text: a.title });
      col.createDiv({ cls: "zk-qa-sub", text: a.sub });
      card.addEventListener("click", () => a.run());
    }
  }

  private sendPreset(text: string) {
    if (this.running) return;
    this.hidePalette();
    this.inputEl.value = text;
    this.autosize();
    void this.send();
  }

  // ---------- session management ----------

  private sessionId(): string {
    return this.plugin.settings.activeSessionId ?? "";
  }

  private saveCurrentSession() {
    if (!this.history.length) return;
    const s = this.plugin.settings;
    let session = s.sessions.find((x) => x.id === this.sessionId());
    if (!session) {
      session = { id: this.sessionId() || crypto.randomUUID(), name: this.autoSessionName(), createdAt: Date.now(), updatedAt: Date.now(), messages: [] };
      s.sessions.unshift(session);
      s.activeSessionId = session.id;
    }
    session.messages = [...this.history];
    session.updatedAt = Date.now();
    // Keep max 50 sessions
    if (s.sessions.length > 50) s.sessions = s.sessions.slice(0, 50);
    void this.plugin.saveSettings();
  }

  private autoSessionName(): string {
    const first = this.history.find((m) => m.role === "user")?.content ?? "";
    const text = typeof first === "string" ? first : "";
    return text.slice(0, 40).trim() || `Chat ${new Date().toLocaleDateString()}`;
  }

  private newSession() {
    if (this.running) this.stop();
    this.saveCurrentSession();
    this.plugin.settings.activeSessionId = crypto.randomUUID();
    void this.plugin.saveSettings();
    this.history = [];
    this.msgsEl.empty();
    this.renderWelcome();
    this.inputEl.focus();
  }

  private loadSession(session: ChatSession) {
    if (this.running) this.stop();
    this.saveCurrentSession();
    this.plugin.settings.activeSessionId = session.id;
    void this.plugin.saveSettings();
    this.history = [...session.messages];
    this.msgsEl.empty();
    if (!this.history.length) { this.renderWelcome(); return; }
    for (const msg of this.history) {
      if (msg.role === "user") this.renderMsg("user", typeof msg.content === "string" ? msg.content : "");
      else if (msg.role === "assistant" && msg.content) {
        const { body } = this.renderAssistantBlock(false);
        void this.renderMarkdown(typeof msg.content === "string" ? msg.content : "", body);
      }
    }
    this.inputEl.focus();
    this.sessionsDropEl?.hide();
  }

  private deleteSession(id: string) {
    const s = this.plugin.settings;
    s.sessions = s.sessions.filter((x) => x.id !== id);
    if (s.activeSessionId === id) {
      s.activeSessionId = s.sessions[0]?.id ?? null;
      if (s.activeSessionId) {
        const sess = s.sessions[0];
        this.history = [...sess.messages];
        this.msgsEl.empty();
        for (const msg of this.history) {
          if (msg.role === "user") this.renderMsg("user", typeof msg.content === "string" ? msg.content : "");
          else if (msg.role === "assistant" && msg.content) {
            const { body } = this.renderAssistantBlock(false);
            void this.renderMarkdown(typeof msg.content === "string" ? msg.content : "", body);
          }
        }
      } else {
        this.history = [];
        this.msgsEl.empty();
        this.renderWelcome();
      }
    }
    void this.plugin.saveSettings();
    this.renderSessionsDrop();
  }

  private toggleSessionsDrop() {
    if (!this.sessionsDropEl) return;
    if (this.sessionsDropEl.isShown()) { this.sessionsDropEl.hide(); return; }
    this.renderSessionsDrop();
    this.sessionsDropEl.show();
  }

  private renderSessionsDrop() {
    const drop = this.sessionsDropEl;
    if (!drop) return;
    drop.empty();
    const sessions = this.plugin.settings.sessions;
    if (!sessions.length) {
      drop.createDiv({ cls: "zk-sessions-empty", text: "No saved sessions" });
      return;
    }
    for (const sess of sessions) {
      const item = drop.createDiv({ cls: "zk-session-item" + (sess.id === this.sessionId() ? " is-active" : "") });
      const meta = item.createDiv({ cls: "zk-session-meta" });
      meta.createDiv({ cls: "zk-session-name", text: sess.name });
      meta.createDiv({ cls: "zk-session-date", text: new Date(sess.updatedAt).toLocaleDateString() });
      item.addEventListener("click", (e) => { e.stopPropagation(); this.loadSession(sess); });
      const del = item.createEl("button", { cls: "zk-session-del clickable-icon", attr: { "aria-label": "Delete" } });
      setIcon(del, "trash-2");
      del.addEventListener("click", (e) => { e.stopPropagation(); this.deleteSession(sess.id); });
    }
  }

  private resetConversation() {
    this.newSession();
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

  // ---------- slash command palette ----------

  private paletteCommands(): PaletteCommand[] {
    const cmds: PaletteCommand[] = [...this.quickActions()];
    if (this.plugin.settings.provider === "hosted") {
      for (const o of MODEL_OPTIONS) {
        cmds.push({
          group: "Model",
          icon: "cpu",
          title: o.label,
          sub: o.value === this.plugin.settings.modelChoice ? "Current model" : o.value === "auto" ? "air for simple, 5.2 for hard tasks" : "Pin this model",
          run: () => this.setModel(o.value),
        });
      }
    }
    for (const id of EFFORT_ORDER) {
      cmds.push({
        group: "Effort",
        icon: "gauge",
        title: EFFORTS[id].label,
        sub: EFFORTS[id].hint,
        run: () => this.setEffort(id),
      });
    }
    cmds.push({
      group: "System",
      icon: "refresh-cw",
      title: "Re-index vault",
      sub: "Rebuild the local search index",
      run: () => void this.plugin.buildIndex(),
    });
    cmds.push({
      group: "System",
      icon: "plus",
      title: "New chat",
      sub: "Clear the conversation",
      run: () => this.resetConversation(),
    });
    cmds.push({
      group: "System",
      icon: "settings",
      title: "Open settings",
      sub: "Provider, theme, agent options",
      run: () => this.openSettings(),
    });
    return cmds;
  }

  private updatePalette() {
    const v = this.inputEl.value;
    if (!v.startsWith("/")) {
      this.hidePalette();
      return;
    }
    const q = v.slice(1).toLowerCase().trim();
    const matches = this.paletteCommands().filter(
      (c) => !q || c.title.toLowerCase().includes(q) || c.sub.toLowerCase().includes(q) || c.group.toLowerCase().includes(q),
    );
    const pal = this.paletteEl!;
    pal.empty();
    this.paletteItems = [];
    this.paletteIndex = 0;

    if (!matches.length) {
      pal.createDiv({ cls: "zk-palette-empty", text: "No matching commands" });
    } else {
      const list = pal.createDiv({ cls: "zk-palette-list" });
      let lastGroup = "";
      for (const c of matches) {
        if (c.group !== lastGroup) {
          list.createDiv({ cls: "zk-palette-group", text: c.group });
          lastGroup = c.group;
        }
        const item = list.createDiv({ cls: "zk-palette-item" });
        const ic = item.createSpan({ cls: "zk-palette-icon" });
        setIcon(ic, c.icon);
        const col = item.createDiv({ cls: "zk-palette-text" });
        col.createDiv({ cls: "zk-palette-title", text: c.title });
        col.createDiv({ cls: "zk-palette-sub", text: c.sub });
        const run = () => {
          this.hidePalette();
          this.inputEl.value = "";
          this.autosize();
          c.run();
        };
        item.addEventListener("mousedown", (e) => {
          e.preventDefault(); // keep textarea focus
          run();
        });
        const idx = this.paletteItems.length;
        item.addEventListener("mouseenter", () => this.highlightPalette(idx));
        this.paletteItems.push({ el: item, run });
      }
    }
    this.highlightPalette(0);
    pal.show();
    this.paletteVisible = true;
  }

  private highlightPalette(i: number) {
    this.paletteItems.forEach((it, n) => it.el.toggleClass("is-active", n === i));
    this.paletteIndex = i;
  }

  private movePalette(delta: number) {
    if (!this.paletteItems.length) return;
    const next = (this.paletteIndex + delta + this.paletteItems.length) % this.paletteItems.length;
    this.highlightPalette(next);
    this.paletteItems[next].el.scrollIntoView({ block: "nearest" });
  }

  private hidePalette() {
    this.paletteEl?.hide();
    this.paletteVisible = false;
    this.paletteItems = [];
  }

  // ---------- send ----------

  private async send() {
    const q = this.inputEl.value.trim();
    if (!q || this.running) return;
    this.hidePalette();
    if (q.startsWith("/")) {
      // fallback for typed commands with the palette dismissed
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
      const map: Record<string, ModelChoice> = { auto: "auto", air: "glm-4.5-air", fast: "glm-4.5-air", smart: "glm-5.2", "5.2": "glm-5.2", turbo: "glm-5-turbo", "4.7": "glm-4.7", "4.6": "glm-4.6" };
      const pick = map[arg] || (MODEL_BY_ID[arg] ? arg : "");
      if (arg && pick) {
        this.setModel(pick);
        this.renderMsg("assistant", `Model set to ${this.modelLabel(pick)}.`);
        return;
      }
      const wrap = this.msgsEl.createDiv({ cls: "vm-msg vm-assistant zk-cmd" });
      wrap.createDiv({ text: `Model — current: ${this.modelLabel(this.plugin.settings.modelChoice)}. Pick one:` });
      const row = wrap.createDiv({ cls: "zk-cmd-btns" });
      for (const o of MODEL_OPTIONS) {
        const b = row.createEl("button", { text: o.label, cls: o.value === this.plugin.settings.modelChoice ? "mod-cta" : "" });
        b.addEventListener("click", () => {
          this.setModel(o.value);
          this.renderMsg("assistant", `Model set to ${this.modelLabel(o.value)}.`);
        });
      }
      this.scroll();
      return;
    }
    if (name === "help") {
      this.renderMsg("assistant", "Type / in the input to open the command menu: quick actions, model, effort, re-index, settings.");
      return;
    }
    this.renderMsg("assistant", `Unknown command /${name}. Type / to see available commands.`);
  }

  // ---------- agent flow ----------

  private async sendAgent(q: string) {
    const s = this.plugin.settings;
    const effort = EFFORTS[s.effort];
    const provider = this.plugin.getProvider();
    const activePath = this.activeContextPath();
    const routed = chooseModel(q, s.effort, s.modelChoice);
    // GLM routing only applies to the hosted subscription; Claude Code and BYOK
    // use whatever model the CLI/endpoint is configured with.
    if (s.provider === "hosted") this.renderModelBadge(routed.model, routed.label, routed.reason);

    const messages: ChatMessage[] = [
      { role: "system", content: agentSystemPrompt(activePath, effort.directive) },
      ...this.history.slice(-8),
      { role: "user", content: q },
    ];

    const thinking = this.renderThinkingRow();
    let finalBlock: HTMLElement | null = null;
    let lastRunningStepEl: HTMLElement | null = null;
    try {
      const finalText = await runAgent(
        provider,
        this.app,
        this.plugin.index,
        messages,
        { autoApprove: s.autoApprove, maxSteps: effort.maxSteps, model: routed.model, signal: this.abort!.signal },
        {
          onText: (text) => {
            if (!text.trim()) return;
            thinking.hide();
            const { block, body } = this.renderAssistantBlock(false);
            finalBlock = block;
            void this.renderMarkdown(text, body);
            this.scroll();
          },
          onStep: (step) => {
            thinking.hide();
            if (step.status === "running") {
              lastRunningStepEl = this.renderStep(step);
            } else if (lastRunningStepEl) {
              this.updateStep(lastRunningStepEl, step);
              lastRunningStepEl = null;
            } else {
              this.renderStep(step);
            }
          },
          confirmWrite: (name, args, preview) => this.askApproval(name, args, preview),
        },
      );
      thinking.remove();
      if (finalBlock) this.addCopyButton(finalBlock, finalText);
      this.history.push({ role: "user", content: q }, { role: "assistant", content: finalText });
      this.saveCurrentSession();
    } catch (e) {
      thinking.remove();
      const msg = e instanceof Error ? e.message : String(e);
      if (!/abort/i.test(msg)) this.renderError(msg, (e as any)?.checkoutUrl);
    }
  }

  private renderModelBadge(model: string, label: string, reason: string) {
    const el = this.msgsEl.createDiv({ cls: "vm-step zk-model-badge" });
    const ic = el.createSpan({ cls: "vm-step-icon" });
    setIcon(ic, MODEL_BY_ID[model]?.reasoning ? "brain" : "zap");
    el.createSpan({ cls: "vm-step-label", text: `${label} · ${reason}` });
    this.scroll();
  }

  private renderThinkingRow(): HTMLElement {
    const el = this.msgsEl.createDiv({ cls: "zk-thinking" });
    el.createSpan({ cls: "zk-thinking-label", text: "Thinking" });
    el.createSpan({ cls: "zk-dot" });
    el.createSpan({ cls: "zk-dot" });
    el.createSpan({ cls: "zk-dot" });
    this.scroll();
    return el;
  }

  private renderStep(step: AgentStep): HTMLElement {
    const el = this.msgsEl.createDiv({ cls: `vm-step vm-step-${step.status}` });
    this.fillStep(el, step);
    this.scroll();
    return el;
  }

  private updateStep(el: HTMLElement, step: AgentStep) {
    el.className = `vm-step vm-step-${step.status}`;
    el.empty();
    this.fillStep(el, step);
    this.scroll();
  }

  private fillStep(el: HTMLElement, step: AgentStep) {
    const ic = el.createSpan({ cls: "vm-step-icon" });
    setIcon(ic, TOOL_ICONS[step.name] ?? "wrench");
    const target = step.args?.path ?? step.args?.query ?? step.args?.folder ?? "";
    const verb = step.status === "rejected" ? "rejected" : step.status === "error" ? "failed" : step.name.replace(/_/g, " ");
    el.createSpan({ cls: "vm-step-label", text: `${verb}${target ? " — " + target : ""}` });
    if (step.status === "done" && step.output && step.name.startsWith("search")) {
      const det = el.createEl("details");
      det.createEl("summary", { text: "result" });
      det.createEl("pre", { text: step.output.slice(0, 1200) });
    }
  }

  private askApproval(name: string, args: any, preview: ToolResult["preview"] | null): Promise<boolean> {
    return new Promise((resolve) => {
      const card = this.msgsEl.createDiv({ cls: "vm-approve" });
      const head = card.createDiv({ cls: "vm-approve-head" });
      const ic = head.createSpan({ cls: "vm-approve-icon" });
      setIcon(ic, TOOL_ICONS[name] ?? "wrench");
      head.createSpan({ cls: "vm-approve-title", text: preview?.title ?? name });
      const { added, removed } = diffStats(preview?.before, preview?.after);
      if (added || removed) {
        const stats = head.createSpan({ cls: "vm-diff-stats" });
        stats.createSpan({ cls: "vm-diff-plus", text: `+${added}` });
        stats.createSpan({ cls: "vm-diff-minus", text: `-${removed}` });
      }

      if (preview?.after !== undefined || preview?.before !== undefined) {
        const det = card.createEl("details", { cls: "vm-diff" });
        det.open = true;
        det.createEl("summary", { text: "Diff" });
        if (name === "edit_note" || name === "append_note") {
          if (preview.before !== undefined) det.createEl("pre", { cls: "vm-diff-before", text: trunc(preview.before) });
        }
        if (preview.after !== undefined) det.createEl("pre", { cls: "vm-diff-after", text: trunc(preview.after) });
        else if (name === "delete_note") det.createEl("pre", { cls: "vm-diff-before", text: "This note will be moved to trash." });
      }

      const btns = card.createDiv({ cls: "vm-approve-btns" });
      const done = (ok: boolean) => {
        btns.remove();
        card.addClass(ok ? "vm-approved" : "vm-rejected");
        card.createSpan({ cls: "vm-approve-verdict", text: ok ? "✓ approved" : "✕ rejected" });
        resolve(ok);
      };
      btns.createEl("button", { text: "Reject" }).addEventListener("click", () => done(false));
      btns.createEl("button", { cls: "mod-cta", text: "Approve" }).addEventListener("click", () => done(true));
      this.scroll();
    });
  }

  // ---------- plain (RAG) flow ----------

  private async sendPlain(q: string) {
    const s = this.plugin.settings;
    let context = "";
    let sources: string[] = [];
    if (s.vaultQA) {
      const active = this.activeContextPath();
      const hits = this.plugin.index.search(q, EFFORTS[s.effort].topK, active);
      if (s.debugMode && hits.length) {
        this.renderMsg("assistant", "Debug — retrieved:\n" + hits.map((h, i) => `${i + 1}. ${h.title} (${h.score.toFixed(2)})`).join("\n"));
      }
      if (hits.length === 0 && this.plugin.index.ready) {
        this.renderMsg("assistant", "Nothing in your vault matches this query — try rephrasing it.");
        return;
      }
      context = hits.map((h, i) => `[${i + 1}] from [[${h.title}]]${h.heading ? " — " + h.heading : ""}:\n${h.text}`).join("\n\n");
      sources = [...new Set(hits.map((h) => h.title))];
    }

    const system = [
      "You are AI Chat, an assistant living inside the user's Obsidian vault.",
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

    const routed = chooseModel(q, s.effort, s.modelChoice);
    const { block, body } = this.renderAssistantBlock(true);
    try {
      let acc = "";
      const full = await this.plugin.getProvider().chat({ messages, model: routed.model, signal: this.abort!.signal }, (delta) => {
        acc += delta;
        body.setText(acc); // replaces the thinking indicator
        this.scroll();
      });
      const md = full + (sources.length ? `\n\n---\nSources: ${sources.map((t) => `[[${t}]]`).join(" · ")}` : "");
      await this.renderMarkdown(md, body);
      this.addCopyButton(block, full);
      this.history.push({ role: "user", content: q }, { role: "assistant", content: full });
      this.saveCurrentSession();
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      const checkoutUrl = (e as any)?.checkoutUrl;
      if (/abort/i.test(msg)) { body.setText("⏹ stopped"); }
      else { body.empty(); this.fillError(body, msg, checkoutUrl); }
    }
  }

  // ---------- message rendering ----------

  private roleHeader(parent: HTMLElement, role: "user" | "assistant") {
    const h = parent.createDiv({ cls: "zk-msghead" });
    const ic = h.createSpan({ cls: "zk-msghead-icon" });
    setIcon(ic, role === "user" ? "user" : "ai-chat");
    h.createSpan({ cls: "zk-msghead-name", text: role === "user" ? "You" : "AI Chat" });
  }

  /** Error as an assistant message, with a short "Subscribe" link when the
   *  error carries a checkout URL (instead of dumping the long raw URL). */
  private renderError(msg: string, checkoutUrl?: string) {
    const wrap = this.msgsEl.createDiv({ cls: "vm-msg vm-assistant" });
    this.roleHeader(wrap, "assistant");
    this.fillError(wrap.createDiv({ cls: "vm-msg-body" }), msg, checkoutUrl);
    this.scroll();
  }

  private fillError(body: HTMLElement, msg: string, checkoutUrl?: string) {
    body.createSpan({ text: `⚠️ ${msg} ` });
    if (checkoutUrl) {
      const link = body.createEl("a", { cls: "zk-subscribe", text: "Subscribe", href: checkoutUrl });
      link.addEventListener("click", (e) => { e.preventDefault(); window.open(checkoutUrl); });
    }
  }

  private renderAssistantBlock(thinking: boolean): { block: HTMLElement; body: HTMLElement } {
    const block = this.msgsEl.createDiv({ cls: "vm-msg vm-assistant" });
    this.roleHeader(block, "assistant");
    const body = block.createDiv({ cls: "vm-msg-body" });
    if (thinking) {
      const t = body.createDiv({ cls: "zk-thinking" });
      t.createSpan({ cls: "zk-thinking-label", text: "Thinking" });
      t.createSpan({ cls: "zk-dot" });
      t.createSpan({ cls: "zk-dot" });
      t.createSpan({ cls: "zk-dot" });
    }
    this.scroll();
    return { block, body };
  }

  private renderMsg(role: "user" | "assistant", text: string): HTMLElement {
    const wrap = this.msgsEl.createDiv({ cls: `vm-msg vm-${role}` });
    this.roleHeader(wrap, role);
    wrap.createDiv({ cls: "vm-msg-body", text });
    this.scroll();
    return wrap;
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
    const active = this.app.workspace.getActiveFile()?.path ?? "";
    el.querySelectorAll<HTMLAnchorElement>("a.internal-link").forEach((a) => {
      const target = a.getAttribute("data-href") ?? a.textContent ?? "";
      // The model sometimes cites category labels/headings it saw inside a note
      // as [[wikilinks]] to notes that don't exist. Render those as plain text
      // instead of a blank, broken, clickable link.
      const dest = this.app.metadataCache.getFirstLinkpathDest(target, active);
      if (!dest) {
        a.replaceWith(document.createTextNode(a.textContent ?? target));
        return;
      }
      a.addEventListener("click", (e) => {
        e.preventDefault();
        void this.app.workspace.openLinkText(target, "", false);
      });
    });
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

/** Rough line-level +/− counts for the approval card header. */
function diffStats(before?: string, after?: string): { added: number; removed: number } {
  const b = before?.split("\n") ?? [];
  const a = after?.split("\n") ?? [];
  const count = (lines: string[]) => {
    const m = new Map<string, number>();
    for (const l of lines) m.set(l, (m.get(l) ?? 0) + 1);
    return m;
  };
  const bm = count(b);
  let added = 0;
  for (const l of a) {
    const left = bm.get(l) ?? 0;
    if (left > 0) bm.set(l, left - 1);
    else added++;
  }
  let removed = 0;
  for (const n of bm.values()) removed += n;
  return { added, removed };
}
