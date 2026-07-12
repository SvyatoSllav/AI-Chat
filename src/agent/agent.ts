import { App } from "obsidian";
import type { VaultIndex } from "../rag/indexer";
import { ChatMessage, LLMProvider } from "../providers/types";
import { TOOL_SPECS, WRITE_TOOLS, executeTool, previewTool, ToolResult } from "./tools";

// ── Context-window compaction ─────────────────────────────────────────────────

function estimateTokens(messages: ChatMessage[]): number {
  return messages.reduce((sum, m) => {
    const text = typeof m.content === "string" ? m.content : JSON.stringify(m.content ?? "");
    const calls = m.tool_calls ? JSON.stringify(m.tool_calls) : "";
    return sum + Math.ceil((text.length + calls.length) / 4) + 4;
  }, 0);
}

// Actual context windows per model (verified from OpenRouter / Z.ai docs, July 2026)
const CTX_WINDOWS: Record<string, number> = {
  "glm-5.2":      1_048_576, // 1M
  "glm-4.7":        202_752,
  "glm-4.6":        202_752,
  "glm-4.5-air":    131_072,
  "glm-5-turbo":    131_072,
  // aliases the backend sends
  "smart":          202_752, // maps to glm-4.6
  "fast":           131_072, // maps to glm-4.5-air
  // other providers
  "claude-3":       200_000,
  "claude-sonnet":  200_000,
  "claude-opus":    200_000,
  "claude-haiku":   200_000,
  "gpt-4o":         128_000,
  "gpt-4-turbo":    128_000,
  "gpt-4":            8_192,
  "gpt-3.5":         16_385,
  "qwen2.5":        131_072,
  "qwen3":          131_072,
  "qwen":            32_000,
  "llama-3":        128_000,
  "llama":            8_000,
};

function contextWindowFor(model: string | undefined): number {
  if (!model) return 32_000;
  const m = model.toLowerCase();
  for (const [key, size] of Object.entries(CTX_WINDOWS)) {
    if (m.includes(key)) return size;
  }
  return 32_000; // conservative default for unknown models
}

/**
 * If the accumulated messages are approaching the context limit, summarise the
 * older portion using the model and replace it with a compact summary — the
 * same strategy Claude Code uses for /compact.
 *
 * Falls back to a simple drop with a note if the summary call fails.
 */
async function compactMessages(
  messages: ChatMessage[],
  model: string | undefined,
  provider: LLMProvider,
  signal?: AbortSignal,
): Promise<ChatMessage[]> {
  const limit = contextWindowFor(model);
  if (estimateTokens(messages) < limit * 0.80) return messages;

  const systemMsg = messages.find((m) => m.role === "system");
  const rest = messages.filter((m) => m.role !== "system");
  const KEEP = 10; // keep last 10 non-system messages verbatim
  if (rest.length <= KEEP + 2) return messages;

  const toSummarize = rest.slice(0, rest.length - KEEP);
  const recent = rest.slice(rest.length - KEEP);

  // Build a readable digest — truncate large tool results so the summary
  // request itself doesn't hit the context limit.
  const historyText = toSummarize
    .map((m) => {
      if (m.role === "assistant" && m.tool_calls?.length) {
        const calls = m.tool_calls.map((tc) => `${tc.function.name}(${tc.function.arguments.slice(0, 120)})`).join(", ");
        return `ASSISTANT → tools: ${calls}`;
      }
      if (m.role === "tool") {
        const body = (m.content ?? "").slice(0, 800);
        return `TOOL RESULT (${m.name ?? "tool"}): ${body}${(m.content?.length ?? 0) > 800 ? " …[truncated]" : ""}`;
      }
      const body = (typeof m.content === "string" ? m.content : "").slice(0, 600);
      return `${m.role.toUpperCase()}: ${body}`;
    })
    .join("\n\n");

  // Prompt mirrors Claude Code's compact strategy: thorough but focused on
  // what matters for resuming an agentic vault task.
  const summaryPrompt: ChatMessage[] = [
    {
      role: "user",
      content:
        "Your task is to create a detailed summary of the following conversation between a user and an AI agent working inside an Obsidian vault. " +
        "This summary will replace the older context so the agent can continue without losing important information.\n\n" +
        "Capture precisely:\n" +
        "1. The user's original request\n" +
        "2. Which notes were searched and found (exact titles)\n" +
        "3. Key facts discovered from reading notes\n" +
        "4. Any notes created or edited, and what changed\n" +
        "5. What is still pending or needs to be done\n\n" +
        "Conversation to summarise:\n\n" + historyText +
        "\n\nWrite a concise but complete summary (4–8 sentences). Be specific about note titles and facts.",
    },
  ];

  let summary = "";
  try {
    summary = await provider.chat({ messages: summaryPrompt, signal }, () => {});
  } catch {
    // Summary failed — fall back to a simple trim with a breadcrumb note.
    console.warn("[AI Chat] compaction summary call failed, falling back to trim");
    return [
      ...(systemMsg ? [systemMsg] : []),
      { role: "system" as const, content: `[${toSummarize.length} earlier messages trimmed — context window limit. Summary unavailable.]` },
      ...recent,
    ];
  }

  console.log(`[AI Chat] compacted ${toSummarize.length} msgs → summary (ctx limit ${limit})`);
  return [
    ...(systemMsg ? [systemMsg] : []),
    {
      role: "system" as const,
      content:
        "This conversation is being continued from earlier context that exceeded the context window. " +
        "The following summary covers what happened before:\n\n" +
        summary,
    },
    ...recent,
  ];
}

export const AGENT_SYSTEM_PROMPT = [
  "You are AI Chat, a thorough research agent living inside the user's Obsidian vault.",
  "You can search, read, create, edit, append to, and delete notes using the provided tools.",

  // ── RESEARCH BEFORE ANSWER ────────────────────────────────────────────────
  "RESEARCH RULE: For ANY question about vault content, you must read the relevant notes with read_note BEFORE answering. Searching alone is NEVER enough — search only shows you what to read next.",
  "MINIMUM READS: For summary/analysis/research tasks, call read_note on EVERY note you plan to mention. If you found 5 plausible notes in search, read all 5. Never stop after reading just one.",
  "READ BEFORE YOU WRITE: If you caught yourself about to write a sentence about a note's contents without having called read_note on it this turn — stop and read it first.",

  // ── TOOL LOOP ─────────────────────────────────────────────────────────────
  "KEEP GOING: After every search or read, decide what to open or do NEXT and immediately make that tool call. Do NOT narrate your plan — just execute it. Only stop calling tools when you have personally read every note you need and are ready to give a complete final answer.",
  "EDIT RULE: To change a note you must read it first, then edit the full content.",

  // ── GROUNDING ─────────────────────────────────────────────────────────────
  "GROUNDING: search_vault returns only titles and short snippets — they are breadcrumbs, not evidence. You may NOT quote, paraphrase, or draw conclusions from a snippet. You may only present information from a note after calling read_note on that exact path.",
  "FABRICATION CHECK: Before each sentence in your answer, verify: did I read_note the source of this claim in this session? If no → delete the sentence or go read the note.",

  // ── CITATIONS ─────────────────────────────────────────────────────────────
  "CITATIONS: only use [[wikilinks]] for paths you personally opened with read_note. NEVER turn a category name, heading, tag, or label found inside a note into a [[wikilink]] — those are not note paths and produce broken links.",

  // ── CONNECTIVITY ──────────────────────────────────────────────────────────
  "CONNECTIVITY: new or edited notes must not be islands. Before finishing, search for related notes, read the most relevant ones, and weave [[wikilinks]] to those REAL existing notes into the body.",

  // ── FINAL SELF-CHECK ──────────────────────────────────────────────────────
  "SELF-CHECK (silent): Before writing your final answer, go through: (1) List every note you are about to cite. (2) Did I call read_note on each one? If any answer is 'no', call read_note now. (3) Am I making any claims from search snippets only? Remove them.",

  "Keep the user's existing style, headings, and frontmatter.",
  "In your final answer, tell the user what you did and list the notes you actually read as [[wikilinks]].",
  "If a request is genuinely ambiguous, ask one brief clarifying question before acting.",
].join("\n\n");

export interface AgentStep {
  name: string;
  args: any;
  status: "running" | "done" | "rejected" | "error";
  output?: string;
  preview?: ToolResult["preview"];
}

export interface AgentCallbacks {
  onText(text: string): void;
  onStep(step: AgentStep): void;
  /** Ask the user to approve a write. Resolves true=approve, false=reject. */
  confirmWrite(name: string, args: any, preview: ToolResult["preview"] | null): Promise<boolean>;
}

export interface AgentOptions {
  autoApprove: boolean;
  maxSteps: number;
  model?: string; // GLM model id (or "fast"/"smart" alias)
  signal?: AbortSignal;
}

/** Builds the agent system prompt, folding in the effort directive if any. */
export function agentSystemPrompt(activePath: string | undefined, directive: string): string {
  return [
    AGENT_SYSTEM_PROMPT,
    directive || "",
    activePath ? `The user's currently open note is: ${activePath}` : "",
  ]
    .filter(Boolean)
    .join("\n\n");
}

/** Runs the tool-calling loop. Returns the final assistant text. */
export async function runAgent(
  provider: LLMProvider,
  app: App,
  index: VaultIndex,
  messages: ChatMessage[],
  opts: AgentOptions,
  cb: AgentCallbacks,
): Promise<string> {
  if (!provider.complete) {
    throw new Error("This provider doesn't support agent tools. Switch provider in settings.");
  }

  let finalText = "";
  for (let step = 0; step < opts.maxSteps; step++) {
    if (opts.signal?.aborted) throw new DOMException("Aborted", "AbortError");

    messages = await compactMessages(messages, opts.model, provider, opts.signal);
    const res = await provider.complete({ messages, tools: TOOL_SPECS, signal: opts.signal, firstOfTurn: step === 0, model: opts.model });
    if (res.text) {
      finalText = res.text;
      cb.onText(res.text);
    }

    messages.push({
      role: "assistant",
      content: res.text,
      tool_calls: res.toolCalls.length
        ? res.toolCalls.map((tc) => ({ id: tc.id, type: "function", function: { name: tc.name, arguments: tc.arguments } }))
        : undefined,
    });

    if (!res.toolCalls.length) return finalText; // model is done

    for (const tc of res.toolCalls) {
      let args: any = {};
      try { args = tc.arguments ? JSON.parse(tc.arguments) : {}; } catch { /* executor reports */ }

      if (WRITE_TOOLS.has(tc.name) && !opts.autoApprove) {
        const preview = await previewTool(app, tc.name, args).catch(() => null);
        const ok = await cb.confirmWrite(tc.name, args, preview ?? null);
        if (!ok) {
          cb.onStep({ name: tc.name, args, status: "rejected", preview: preview ?? undefined });
          messages.push({ role: "tool", tool_call_id: tc.id, name: tc.name, content: "User rejected this action. Do not retry it; consider an alternative or ask." });
          continue;
        }
      }

      cb.onStep({ name: tc.name, args, status: "running" });
      const result = await executeTool(app, index, tc.name, tc.arguments);
      const errored = result.output.startsWith("Error");
      cb.onStep({ name: tc.name, args, status: errored ? "error" : "done", output: result.output });
      messages.push({ role: "tool", tool_call_id: tc.id, name: tc.name, content: result.output });
    }
  }
  return finalText || "(Stopped: reached the step limit. Ask me to continue.)";
}
