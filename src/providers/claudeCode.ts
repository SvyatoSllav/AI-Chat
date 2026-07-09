import { Platform } from "obsidian";
import { ChatRequest, LLMProvider } from "./types";

/**
 * Dev-stage default: shells out to the user's official Claude Code CLI.
 * Desktop only. We never touch OAuth tokens — only run the official binary
 * the user installed and authenticated themselves.
 */
export class ClaudeCodeProvider implements LLMProvider {
  id = "claude-code";
  supportsMobile = false;

  constructor(private binPath: string) {}

  async chat(req: ChatRequest, onDelta: (chunk: string) => void): Promise<string> {
    if (!Platform.isDesktopApp) {
      throw new Error("Claude Code provider is desktop-only. Switch provider in settings.");
    }
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { spawn } = require("child_process") as typeof import("child_process");

    const prompt = req.messages
      .map((m) => `${m.role.toUpperCase()}:\n${m.content}`)
      .join("\n\n");

    return new Promise<string>((resolve, reject) => {
      const child = spawn(
        this.binPath || "claude",
        ["-p", "--output-format", "stream-json", "--verbose"],
        { stdio: ["pipe", "pipe", "pipe"] },
      );
      let full = "";
      let buf = "";
      let err = "";

      req.signal?.addEventListener("abort", () => child.kill("SIGTERM"));
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
        reject(new Error(`Cannot run Claude Code CLI (${e.message}). Is it installed and on PATH?`)),
      );
    });
  }
}
