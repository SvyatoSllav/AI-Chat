export interface ToolCall {
  id: string;
  name: string;
  arguments: string; // raw JSON string from the model
}

export interface ChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  // assistant turns that call tools carry them here (OpenAI shape)
  tool_calls?: Array<{ id: string; type: "function"; function: { name: string; arguments: string } }>;
  // tool result messages reference the call they answer
  tool_call_id?: string;
  name?: string;
}

export interface ToolSpec {
  type: "function";
  function: { name: string; description: string; parameters: Record<string, unknown> };
}

export interface ChatRequest {
  messages: ChatMessage[];
  model?: string;
  signal?: AbortSignal;
}

export interface CompletionRequest extends ChatRequest {
  tools?: ToolSpec[];
  /** True on the first model call of a user turn — hosted provider uses it so
   *  agent tool-steps don't each cost a free-quota message. */
  firstOfTurn?: boolean;
}

export interface CompletionResult {
  text: string;
  toolCalls: ToolCall[];
}

export interface LLMProvider {
  id: string;
  readonly supportsMobile: boolean;
  /** Streams deltas via onDelta, resolves with the full response text. Plain chat. */
  chat(req: ChatRequest, onDelta: (chunk: string) => void): Promise<string>;
  /** One agent turn: may return tool calls to execute. Only providers that
   *  support OpenAI tool-calling implement this; others leave it undefined. */
  complete?(req: CompletionRequest): Promise<CompletionResult>;
}
