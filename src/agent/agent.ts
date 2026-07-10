import { App } from "obsidian";
import type { VaultIndex } from "../rag/indexer";
import { ChatMessage, LLMProvider } from "../providers/types";
import { TOOL_SPECS, WRITE_TOOLS, executeTool, previewTool, ToolResult } from "./tools";

export const AGENT_SYSTEM_PROMPT = [
  "You are ZettelkastenAI, an agent living inside the user's Obsidian vault.",
  "You can search, read, create, edit, append to, and delete notes using the provided tools.",
  "Work in small concrete steps: to change a note, read it first, then edit it.",
  "Prefer [[wikilinks]] to connect notes, and keep the user's existing style, headings, and frontmatter.",
  "When you create or change notes, tell the user plainly what you did and cite the notes as [[wikilinks]].",
  "If a request is ambiguous or would touch many notes, ask a brief clarifying question before acting.",
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
  signal?: AbortSignal;
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
    throw new Error("This provider doesn't support agent tools. Switch to the subscription or an OpenAI-compatible endpoint in settings.");
  }

  let finalText = "";
  for (let step = 0; step < opts.maxSteps; step++) {
    if (opts.signal?.aborted) throw new DOMException("Aborted", "AbortError");

    const res = await provider.complete({ messages, tools: TOOL_SPECS, signal: opts.signal, firstOfTurn: step === 0 });
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
