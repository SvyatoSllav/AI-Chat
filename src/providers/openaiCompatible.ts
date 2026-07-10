import { Platform, requestUrl } from "obsidian";
import { ChatRequest, CompletionRequest, CompletionResult, LLMProvider } from "./types";
import { completeWithTools } from "./openaiTools";

/**
 * Any OpenAI-compatible endpoint: DeepSeek, OpenRouter, Ollama, Z.ai (GLM).
 * The prod GLM provider is this class pointed at Z.ai with a leased credential.
 */
export class OpenAICompatibleProvider implements LLMProvider {
  id = "openai-compatible";
  supportsMobile = true;

  constructor(
    private baseUrl: string,
    private apiKey: string,
    private model: string,
  ) {}

  async complete(req: CompletionRequest): Promise<CompletionResult> {
    const url = this.baseUrl.replace(/\/+$/, "") + "/chat/completions";
    return completeWithTools(url, { Authorization: `Bearer ${this.apiKey}` }, req.model ?? this.model, req);
  }

  async chat(req: ChatRequest, onDelta: (chunk: string) => void): Promise<string> {
    const url = this.baseUrl.replace(/\/+$/, "") + "/chat/completions";
    const body = {
      model: req.model ?? this.model,
      messages: req.messages,
    };

    let res: Response;
    try {
      res = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${this.apiKey}`,
        },
        body: JSON.stringify({ ...body, stream: true }),
        signal: req.signal,
      });
    } catch (e) {
      if (req.signal?.aborted) throw e;
      // Mobile: fetch is CORS-blocked for most providers. Fall back to
      // Obsidian requestUrl (no CORS, no streaming) — answer arrives whole.
      if (Platform.isMobileApp) return this.chatViaRequestUrl(url, body, onDelta);
      throw e;
    }
    if (!res.ok || !res.body) {
      const detail = await res.text().catch(() => "");
      throw new Error(`Provider HTTP ${res.status}: ${friendlyHttpHint(res.status)}${detail.slice(0, 300)}`);
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let full = "";
    let buf = "";
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      const lines = buf.split("\n");
      buf = lines.pop() ?? "";
      for (const line of lines) {
        if (!line.startsWith("data:")) continue;
        const data = line.slice(5).trim();
        if (!data || data === "[DONE]") continue;
        try {
          const delta = JSON.parse(data).choices?.[0]?.delta?.content;
          if (delta) {
            full += delta;
            onDelta(delta);
          }
        } catch {
          /* keep-alive / partial frame */
        }
      }
    }
    return full;
  }

  private async chatViaRequestUrl(
    url: string,
    body: { model: string; messages: ChatRequest["messages"] },
    onDelta: (chunk: string) => void,
  ): Promise<string> {
    const res = await requestUrl({
      url,
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify(body),
      throw: false,
    });
    if (res.status >= 400) {
      throw new Error(`Provider HTTP ${res.status}: ${friendlyHttpHint(res.status)}${res.text.slice(0, 300)}`);
    }
    const full: string = res.json?.choices?.[0]?.message?.content ?? "";
    if (full) onDelta(full);
    return full;
  }
}

function friendlyHttpHint(status: number): string {
  if (status === 401) return "API key is missing or invalid — check it in ZettelkastenAI settings. ";
  if (status === 429) return "Rate limit or quota exceeded — check billing/limits at your provider. ";
  return "";
}
