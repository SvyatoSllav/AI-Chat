import type { VaultMindSettings } from "../settings";
import { LLMProvider } from "./types";
import { OpenAICompatibleProvider } from "./openaiCompatible";
import { ClaudeCodeProvider } from "./claudeCode";

export function createProvider(s: VaultMindSettings): LLMProvider {
  switch (s.provider) {
    case "claude-code":
      return new ClaudeCodeProvider(s.claudeCodePath);
    default:
      return new OpenAICompatibleProvider(s.baseUrl, s.apiKey, s.model);
  }
}
