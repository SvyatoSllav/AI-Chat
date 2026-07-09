export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface ChatRequest {
  messages: ChatMessage[];
  model?: string;
  signal?: AbortSignal;
}

export interface LLMProvider {
  id: string;
  readonly supportsMobile: boolean;
  /** Streams deltas via onDelta, resolves with the full response text. */
  chat(req: ChatRequest, onDelta: (chunk: string) => void): Promise<string>;
}
