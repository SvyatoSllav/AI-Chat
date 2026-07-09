import { ChatRequest, LLMProvider } from "./types";

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

  async chat(req: ChatRequest, onDelta: (chunk: string) => void): Promise<string> {
    const url = this.baseUrl.replace(/\/+$/, "") + "/chat/completions";
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify({
        model: req.model ?? this.model,
        messages: req.messages,
        stream: true,
      }),
      signal: req.signal,
    });
    if (!res.ok || !res.body) {
      const detail = await res.text().catch(() => "");
      throw new Error(`Provider HTTP ${res.status}: ${detail.slice(0, 300)}`);
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
}
