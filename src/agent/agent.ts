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

function contextWindowFor(model: string | undefined): number {
  if (!model) return 32_000;
  const m = model.toLowerCase();
  if (m.includes("claude")) return 200_000;
  if (m.includes("glm") || m === "smart" || m === "fast") return 128_000;
  if (m.includes("gpt-4")) return 128_000;
  if (m.includes("gpt-3.5")) return 16_000;
  if (m.includes("qwen2.5") || m.includes("qwen3")) return 128_000;
  if (m.includes("qwen")) return 32_000;
  if (m.includes("llama")) return 8_000;
  return 32_000; // conservative default for unknown models
}

/**
 * If the accumulated messages are approaching the context limit, drop the
 * oldest tool-call rounds, keeping the system prompt + most recent exchanges.
 * No network call — just a local trim with a breadcrumb note.
 */
function compactIfNeeded(messages: ChatMessage[], model: string | undefined): ChatMessage[] {
  const limit = contextWindowFor(model);
  if (estimateTokens(messages) < limit * 0.80) return messages;

  const systemMsg = messages.find((m) => m.role === "system");
  const rest = messages.filter((m) => m.role !== "system");
  const KEEP = 12; // last 6 tool call + result pairs
  if (rest.length <= KEEP + 2) return messages; // nothing worth trimming

  const trimmed = rest.slice(-KEEP);
  const dropped = rest.length - trimmed.length;
  console.log(`[AI Chat] compacted: dropped ${dropped} old messages (ctx limit ${limit})`);
  return [
    ...(systemMsg ? [systemMsg] : []),
    { role: "system", content: `[${dropped} earlier messages dropped — context window limit. Continuing from recent context.]` },
    ...trimmed,
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

    messages = compactIfNeeded(messages, opts.model);
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
