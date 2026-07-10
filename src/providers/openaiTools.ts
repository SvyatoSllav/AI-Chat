import { requestUrl } from "obsidian";
import { CompletionRequest, CompletionResult } from "./types";

/**
 * One non-streaming OpenAI-compatible completion that may return tool calls.
 * Uses Obsidian requestUrl (no CORS issues, works on desktop and mobile).
 * `extraHeaders` lets the hosted provider tag turn boundaries for quota.
 */
export async function completeWithTools(
  url: string,
  auth: Record<string, string>,
  model: string,
  req: CompletionRequest,
  extraHeaders: Record<string, string> = {},
): Promise<CompletionResult> {
  const res = await requestUrl({
    url,
    method: "POST",
    headers: { "Content-Type": "application/json", ...auth, ...extraHeaders },
    body: JSON.stringify({
      model,
      messages: req.messages,
      ...(req.tools ? { tools: req.tools, tool_choice: "auto" } : {}),
      stream: false,
    }),
    throw: false,
  });
  if (res.status >= 400) {
    let detail = "";
    let checkoutUrl = "";
    try { detail = res.json?.error?.message ?? res.json?.error ?? ""; checkoutUrl = res.json?.checkoutUrl ?? ""; } catch { /* non-json */ }
    if (res.status === 401) throw new Error("Auth failed — check your key / sign in again.");
    if (res.status === 402) throw new Error(`${detail || "Free messages used up"}. Subscribe: ${checkoutUrl || "see settings"}`);
    if (res.status === 409) throw new Error(detail || "Agent mode is not available on this provider.");
    if (res.status === 429) throw new Error(detail || "Usage limit reached — try again shortly, or switch to Low effort.");
    throw new Error(`Model HTTP ${res.status}: ${detail}`);
  }
  const msg = res.json?.choices?.[0]?.message ?? {};
  const toolCalls = (msg.tool_calls ?? [])
    .filter((tc: any) => tc?.function?.name)
    .map((tc: any) => ({ id: tc.id ?? crypto.randomUUID(), name: tc.function.name, arguments: tc.function.arguments ?? "{}" }));
  return { text: typeof msg.content === "string" ? msg.content : "", toolCalls };
}
