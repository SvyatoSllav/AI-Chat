import { App, TFile, normalizePath } from "obsidian";
import type { VaultIndex } from "../rag/indexer";
import { ToolSpec } from "../providers/types";
import { extractPdfText } from "../rag/pdf";

// Which tools mutate the vault → gated behind approval unless auto-approve is on.
export const WRITE_TOOLS = new Set(["create_note", "edit_note", "append_note", "delete_note"]);

export const TOOL_SPECS: ToolSpec[] = [
  {
    type: "function",
    function: {
      name: "search_vault",
      description: "Search the user's notes by keywords and links. Returns the most relevant note titles, paths, and matching excerpts. Use this first to find what exists before reading or editing.",
      parameters: {
        type: "object",
        properties: { query: { type: "string", description: "Search query" }, limit: { type: "integer", description: "Max results (default 8)" } },
        required: ["query"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "list_notes",
      description: "List note paths in the vault, optionally under a folder prefix. Use to explore structure.",
      parameters: {
        type: "object",
        properties: { folder: { type: "string", description: "Folder prefix, e.g. 'projects/'. Omit for all." }, limit: { type: "integer" } },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "read_note",
      description: "Read the full content of a note by its path. Works for markdown notes and PDF files (text is extracted from the PDF).",
      parameters: { type: "object", properties: { path: { type: "string", description: "File path, e.g. 'zettel/Deep Work.md' or 'refs/Paper.pdf'" } }, required: ["path"] },
    },
  },
  {
    type: "function",
    function: {
      name: "get_active_note",
      description: "Get the path and content of the note the user currently has open, if any.",
      parameters: { type: "object", properties: {} },
    },
  },
  {
    type: "function",
    function: {
      name: "create_note",
      description: "Create a new note. Fails if the path already exists — use edit_note to change an existing note. Folders are created as needed.",
      parameters: {
        type: "object",
        properties: { path: { type: "string" }, content: { type: "string", description: "Full markdown content" } },
        required: ["path", "content"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "edit_note",
      description: "Replace the entire content of an existing note. Read it first so you preserve what should stay.",
      parameters: {
        type: "object",
        properties: { path: { type: "string" }, content: { type: "string", description: "New full markdown content" } },
        required: ["path", "content"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "append_note",
      description: "Append text to the end of an existing note without rewriting it.",
      parameters: {
        type: "object",
        properties: { path: { type: "string" }, text: { type: "string" } },
        required: ["path", "text"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "delete_note",
      description: "Delete a note by path. This is destructive.",
      parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
    },
  },
];

export interface ToolResult {
  output: string; // fed back to the model
  /** For write tools: a human-readable preview shown in the approval card. */
  preview?: { title: string; before?: string; after?: string };
}

/** Preview a write tool WITHOUT applying it — used to render the approval card. */
export async function previewTool(app: App, name: string, args: any): Promise<ToolResult["preview"] | null> {
  const path = args?.path ? normalizePath(String(args.path)) : "";
  switch (name) {
    case "create_note":
      return { title: `Create ${path}`, after: String(args.content ?? "") };
    case "edit_note": {
      const f = app.vault.getAbstractFileByPath(path);
      const before = f instanceof TFile ? await app.vault.read(f) : "(note not found)";
      return { title: `Edit ${path}`, before, after: String(args.content ?? "") };
    }
    case "append_note": {
      const f = app.vault.getAbstractFileByPath(path);
      const before = f instanceof TFile ? await app.vault.read(f) : "(note not found)";
      return { title: `Append to ${path}`, before, after: before + "\n" + String(args.text ?? "") };
    }
    case "delete_note":
      return { title: `Delete ${path}`, before: "(entire note)" };
    default:
      return null;
  }
}

export async function executeTool(
  app: App,
  index: VaultIndex,
  name: string,
  rawArgs: string,
): Promise<ToolResult> {
  let args: any = {};
  try { args = rawArgs ? JSON.parse(rawArgs) : {}; } catch { return { output: "Error: arguments were not valid JSON." }; }
  const path = args?.path ? normalizePath(String(args.path)) : "";

  try {
    switch (name) {
      case "search_vault": {
        const hits = index.search(String(args.query ?? ""), Number(args.limit) || 8, app.workspace.getActiveFile()?.path);
        if (!hits.length) return { output: "No matching notes." };
        return {
          output: hits.map((h, i) => `${i + 1}. ${h.title} (${h.path})\n   ${h.text.slice(0, 200).replace(/\n/g, " ")}`).join("\n"),
        };
      }
      case "list_notes": {
        const prefix = args.folder ? normalizePath(String(args.folder)) : "";
        let files = app.vault.getMarkdownFiles().map((f) => f.path);
        if (prefix) files = files.filter((p) => p.startsWith(prefix));
        const limit = Number(args.limit) || 100;
        return { output: `${files.length} notes${prefix ? " under " + prefix : ""}:\n` + files.slice(0, limit).join("\n") + (files.length > limit ? `\n… (+${files.length - limit} more)` : "") };
      }
      case "read_note": {
        const f = app.vault.getAbstractFileByPath(path);
        if (!(f instanceof TFile)) return { output: `Error: note not found: ${path}` };
        if (f.extension === "pdf") {
          const text = await extractPdfText(await app.vault.readBinary(f)).catch(() => "");
          return { output: text.trim() ? `PDF text of ${path}:\n\n${text}` : `Error: ${path} has no extractable text (likely a scanned/image PDF).` };
        }
        return { output: await app.vault.read(f) };
      }
      case "get_active_note": {
        const f = app.workspace.getActiveFile();
        if (!f) return { output: "No note is currently open." };
        return { output: `path: ${f.path}\n\n${await app.vault.read(f)}` };
      }
      case "create_note": {
        if (app.vault.getAbstractFileByPath(path)) return { output: `Error: ${path} already exists. Use edit_note.` };
        const dir = path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "";
        if (dir && !app.vault.getAbstractFileByPath(dir)) await app.vault.createFolder(dir).catch(() => {});
        await app.vault.create(path, String(args.content ?? ""));
        return { output: `Created ${path}.` };
      }
      case "edit_note": {
        const f = app.vault.getAbstractFileByPath(path);
        if (!(f instanceof TFile)) return { output: `Error: note not found: ${path}` };
        await app.vault.modify(f, String(args.content ?? ""));
        return { output: `Updated ${path}.` };
      }
      case "append_note": {
        const f = app.vault.getAbstractFileByPath(path);
        if (!(f instanceof TFile)) return { output: `Error: note not found: ${path}` };
        await app.vault.append(f, "\n" + String(args.text ?? ""));
        return { output: `Appended to ${path}.` };
      }
      case "delete_note": {
        const f = app.vault.getAbstractFileByPath(path);
        if (!(f instanceof TFile)) return { output: `Error: note not found: ${path}` };
        await app.fileManager.trashFile(f);
        return { output: `Deleted ${path}.` };
      }
      default:
        return { output: `Error: unknown tool ${name}.` };
    }
  } catch (e) {
    return { output: `Error running ${name}: ${e instanceof Error ? e.message : String(e)}` };
  }
}
