import { Platform } from "obsidian";
import { ChatMessage, ChatRequest, CompletionRequest, CompletionResult, LLMProvider, ToolCall, ToolSpec } from "./types";

// The CLI's own tools are disabled: the vault must only be reachable through
// the plugin's tools (approval gate, index), never via direct filesystem access.
const DISALLOWED_CLI_TOOLS =
  "Bash,Read,Write,Edit,MultiEdit,NotebookEdit,Glob,Grep,LS,WebFetch,WebSearch,Task,TodoWrite";

const TOOL_CALL_RE = /```tool_call\s*([\s\S]*?)```/g;

// GUI-launched Obsidian doesn't inherit the user's shell PATH (nvm, ~/.local/bin
// etc. are set in shell rc files), so a bare "claude" often ENOENTs. Resolve the
// real binary once: ask the login shell first, then scan common install dirs.
let resolvedBin: string | null = null;

async function resolveBin(binPath: string): Promise<string> {
  const want = binPath || "claude";
  if (want.includes("/") || want.includes("\\")) return want; // explicit path from settings
  if (resolvedBin) return resolvedBin;

  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { execFile } = require("child_process") as typeof import("child_process");
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const fs = require("fs") as typeof import("fs");
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const os = require("os") as typeof import("os");

  if (process.platform !== "win32") {
    const shell = process.env.SHELL || "/bin/bash";
    const fromShell = await new Promise<string>((res) =>
      execFile(shell, ["-lc", `command -v ${want}`], { timeout: 5000 }, (e, stdout) =>
        res(e ? "" : (stdout.trim().split("\n").pop() ?? "")),
      ),
    );
    if (fromShell) return (resolvedBin = fromShell);
  }

  const home = os.homedir();
  const candidates = [
    `${home}/.local/bin/${want}`,
    `${home}/.claude/local/${want}`,
    `${home}/bin/${want}`,
    `/usr/local/bin/${want}`,
    `/opt/homebrew/bin/${want}`,
    `${home}/.bun/bin/${want}`,
    `${home}/.volta/bin/${want}`,
    `${home}/.npm-global/bin/${want}`,
  ];
  try {
    const nvm = `${home}/.nvm/versions/node`;
    for (const v of fs.readdirSync(nvm)) candidates.push(`${nvm}/${v}/bin/${want}`);
  } catch { /* no nvm */ }
  for (const c of candidates) {
    try {
      fs.accessSync(c, fs.constants.X_OK);
      return (resolvedBin = c);
    } catch { /* keep looking */ }
  }
  throw new Error(
    "Claude Code CLI not found. Install it (npm i -g @anthropic-ai/claude-code) or set the full path in settings (run `which claude` in a terminal).",
  );
}

/**
 * Uses the official Claude Code CLI the user installed and authenticated
 * themselves (we never touch OAuth tokens). Desktop only.
 *
 * Agent mode is emulated: the CLI has no OpenAI tool-calling API, so tools are
 * described in the prompt and calls are parsed back from fenced `tool_call`
 * JSON blocks.
 */
export class ClaudeCodeProvider implements LLMProvider {
  id = "claude-code";
  supportsMobile = false;

  constructor(private binPath: string, private proxy = "") {}

  async chat(req: ChatRequest, onDelta: (chunk: string) => void): Promise<string> {
    return this.run(serializeMessages(req.messages), req.signal, onDelta);
  }

  async complete(req: CompletionRequest): Promise<CompletionResult> {
    const prompt = [serializeMessages(req.messages), toolProtocol(req.tools ?? [])].join("\n\n");
    const raw = await this.run(prompt, req.signal, () => {});
    return parseToolCalls(raw);
  }

  private async run(prompt: string, signal: AbortSignal | undefined, onDelta: (chunk: string) => void): Promise<string> {
    if (!Platform.isDesktopApp) {
      throw new Error("Claude Code provider is desktop-only. Switch provider in settings.");
    }
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { spawn } = require("child_process") as typeof import("child_process");
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { dirname } = require("path") as typeof import("path");

    const bin = await resolveBin(this.binPath);
    // Binary's dir on PATH so it can find its own helpers (node for npm installs).
    const env: NodeJS.ProcessEnv = { ...process.env, PATH: `${dirname(bin)}:${process.env.PATH ?? ""}` };
    if (this.proxy) {
      env.HTTPS_PROXY = this.proxy;
      env.HTTP_PROXY = this.proxy;
      env.NO_PROXY = "localhost,127.0.0.1";
    }

    return new Promise<string>((resolve, reject) => {
      const child = spawn(
        bin,
        ["-p", "--output-format", "stream-json", "--verbose", "--disallowedTools", DISALLOWED_CLI_TOOLS],
        { stdio: ["pipe", "pipe", "pipe"], env },
      );
      let full = "";
      let buf = "";
      let err = "";

      signal?.addEventListener("abort", () => child.kill("SIGTERM"));
      child.stdin.write(prompt);
      child.stdin.end();

      child.stdout.on("data", (d: Buffer) => {
        buf += d.toString();
        const lines = buf.split("\n");
        buf = lines.pop() ?? "";
        for (const line of lines) {
          if (!line.trim()) continue;
          try {
            const evt = JSON.parse(line);
            if (evt.type === "assistant") {
              for (const block of evt.message?.content ?? []) {
                if (block.type === "text" && block.text) {
                  full += block.text;
                  onDelta(block.text);
                }
              }
            } else if (evt.type === "result" && !full && evt.result) {
              full = evt.result;
              onDelta(evt.result);
            }
          } catch {
            /* verbose non-JSON line */
          }
        }
      });
      child.stderr.on("data", (d: Buffer) => (err += d.toString()));
      child.on("close", (code: number | null) => {
        if (code === 0 || full) resolve(full);
        else reject(new Error(`claude exited ${code}: ${err.slice(0, 400)}`));
      });
      child.on("error", (e: Error) =>
        reject(new Error(`Cannot run Claude Code CLI at ${bin} (${e.message}). Set the full path in settings — run \`which claude\` in a terminal.`)),
      );
    });
  }
}

function serializeMessages(messages: ChatMessage[]): string {
  return messages
    .map((m) => {
      if (m.role === "tool") return `TOOL RESULT (${m.name ?? "tool"}):\n${m.content}`;
      let text = `${m.role.toUpperCase()}:\n${m.content}`;
      // Re-render past emulated calls so the model sees its own history.
      for (const tc of m.tool_calls ?? []) {
        text += `\n\`\`\`tool_call\n${JSON.stringify({ name: tc.function.name, arguments: safeParse(tc.function.arguments) })}\n\`\`\``;
      }
      return text;
    })
    .join("\n\n");
}

function toolProtocol(tools: ToolSpec[]): string {
  const catalog = tools
    .map((t) => `- ${t.function.name}: ${t.function.description}\n  arguments schema: ${JSON.stringify(t.function.parameters)}`)
    .join("\n");
  return [
    "TOOL PROTOCOL:",
    "The vault is ONLY reachable through the tools below — never through your built-in file or shell tools.",
    "To call a tool, end your reply with exactly one fenced block:",
    '```tool_call\n{"name": "<tool name>", "arguments": { ... }}\n```',
    "One tool call per reply. The result arrives as a TOOL RESULT message; then continue.",
    "When the task is fully done, reply with the final answer in plain text and NO tool_call block.",
    "Available tools:",
    catalog,
  ].join("\n");
}

function parseToolCalls(raw: string): CompletionResult {
  const toolCalls: ToolCall[] = [];
  let i = 0;
  const text = raw
    .replace(TOOL_CALL_RE, (match, body: string) => {
      const call = toToolCall(body, i);
      if (!call) return match; // malformed block stays visible as text
      toolCalls.push(call);
      i++;
      return "";
    })
    .trim();

  // Some replies come back as one bare JSON object instead of a fenced block.
  if (!toolCalls.length && text.startsWith("{") && text.endsWith("}")) {
    const call = toToolCall(text, 0);
    if (call) return { text: "", toolCalls: [call] };
  }
  return { text, toolCalls };
}

function toToolCall(body: string, i: number): ToolCall | null {
  const obj = safeParse(body.trim());
  const name = obj?.name ?? obj?.tool;
  if (!name || typeof name !== "string") return null;
  const args = obj.arguments ?? obj.args ?? obj.input ?? {};
  return {
    id: `cc-${Date.now()}-${i}`,
    name,
    arguments: typeof args === "string" ? args : JSON.stringify(args),
  };
}

function safeParse(s: string): any {
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}
