import type { AIChatSettings } from "../settings";
import { LLMProvider } from "./types";
import { OpenAICompatibleProvider } from "./openaiCompatible";
import { ClaudeCodeProvider } from "./claudeCode";
import { HostedProvider } from "./hosted";

export function createProvider(s: AIChatSettings): LLMProvider {
  switch (s.provider) {
    case "claude-code":
      return new ClaudeCodeProvider(s.claudeCodePath, s.claudeCodeProxy);
    case "openai-compatible":
      return new OpenAICompatibleProvider(s.baseUrl, s.apiKey, s.model);
    default:
      return new HostedProvider(s.backendUrl, s.authToken);
  }
}
