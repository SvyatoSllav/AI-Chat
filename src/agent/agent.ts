import { App } from "obsidian";
import type { VaultIndex } from "../rag/indexer";
import { ChatMessage, LLMProvider } from "../providers/types";
import { TOOL_SPECS, WRITE_TOOLS, executeTool, previewTool, ToolResult } from "./tools";

export const AGENT_SYSTEM_PROMPT = [
  "You are ZettelkastenAI, an agent living inside the user's Obsidian vault.",
  "You can search, read, create, edit, append to, and delete notes using the provided tools.",
  "Work in small concrete steps: to change a note, read it first, then edit it.",
  "CRITICAL: keep calling tools until the user's request is FULLY done. Searching or reading is never the end — after you gather information you must go on to actually read every relevant note and perform any requested create/edit/delete. Do NOT stop to narrate what you found or what you plan to do next; just make the next tool call.",
  "Only write your final plain-text answer once the task is completely finished (all notes read, all requested changes made).",
  "GROUNDING: search results give you only titles and short snippets — enough to decide what to open, NOT enough to quote or summarize. Only state the specific contents of a note you have actually opened with read_note. Never quote, paraphrase in detail, or cite a note as a source unless you read it in full this turn, and never claim to have read notes you only saw in search results.",
  "CITATIONS: only use [[wikilinks]] that point to REAL notes you actually opened with read_note this turn (use their exact title/path). NEVER turn a category name, heading, tag, or label you saw INSIDE a note into a [[wikilink]] — those are not notes and produce broken links. If a summary spans several notes, read each one before citing it; do not summarize the whole vault from a single index/MOC note and cite its inner labels as sources.",
  "CONNECTIVITY: a new or edited note must not be an island. Before you finish creating/editing a note, search the vault for related notes, open the most relevant ones, and weave [[wikilinks]] to those REAL existing notes into the body where they fit — this is the whole point of a Zettelkasten. Only link notes that actually exist (ones you found/read); never invent links.",
  "Keep the user's existing style, headings, and frontmatter.",
  "In your final answer, tell the user plainly what you did and cite the notes as [[wikilinks]].",
  "If a request is genuinely ambiguous, ask one brief clarifying question before acting; otherwise proceed.",
  "Never fabricate note contents — if you haven't read a note, read it before relying on it.",
].join(" ");

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
