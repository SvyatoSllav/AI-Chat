import MiniSearch from "minisearch";
import { App, TFile } from "obsidian";
import { Chunk, chunkMarkdown } from "./chunker";

export interface ScoredChunk extends Chunk {
  score: number;
}

const MAX_FILE_SIZE = 2_000_000; // docs/large-vault.md §3
const BATCH = 50; // §1: yield to main thread between batches

const yieldMain = () => new Promise((r) => setTimeout(r, 0));

export class VaultIndex {
  private mini: MiniSearch<Chunk>;
  private chunksByPath = new Map<string, Chunk[]>();
  ready = false;
  private building = false;

  constructor(private app: App) {
    this.mini = this.newMini();
  }

  private newMini(): MiniSearch<Chunk> {
    return new MiniSearch<Chunk>({
      idField: "id",
      fields: ["text", "heading", "title"],
      storeFields: ["path", "title", "heading", "text"],
      searchOptions: { boost: { title: 2, heading: 1.5 }, prefix: true, fuzzy: 0.1 },
    });
  }

  async build(onProgress?: (done: number, total: number) => void): Promise<void> {
    if (this.building) return;
    this.building = true;
    this.mini = this.newMini();
    this.chunksByPath.clear();
    const files = this.app.vault.getMarkdownFiles();
    for (let i = 0; i < files.length; i += BATCH) {
      await Promise.all(files.slice(i, i + BATCH).map((f) => this.indexFile(f)));
      onProgress?.(Math.min(i + BATCH, files.length), files.length);
      await yieldMain();
    }
    this.ready = true;
    this.building = false;
  }

  private async indexFile(file: TFile): Promise<void> {
    if (file.stat.size > MAX_FILE_SIZE) return;
    try {
      const content = await this.app.vault.cachedRead(file);
      const chunks = chunkMarkdown(file.path, content);
      this.chunksByPath.set(file.path, chunks);
      this.mini.addAll(chunks);
    } catch (e) {
      console.warn(`VaultMind: failed to index ${file.path}`, e);
    }
  }

  async updateFile(file: TFile): Promise<void> {
    this.removePath(file.path);
    await this.indexFile(file);
  }

  removePath(path: string): void {
    const old = this.chunksByPath.get(path);
    if (!old) return;
    for (const c of old) this.mini.discard(c.id);
    this.chunksByPath.delete(path);
  }

  async renamePath(file: TFile, oldPath: string): Promise<void> {
    this.removePath(oldPath);
    await this.indexFile(file);
  }

  /** BM25 + graph boost: chunks from notes linked to/from the active note rank higher. */
  search(query: string, topK: number, activePath?: string): ScoredChunk[] {
    if (!this.ready) return [];
    const raw = this.mini.search(query).slice(0, topK * 4);
    const neighbors = activePath ? this.neighborSet(activePath) : null;
    const scored = raw.map((r) => {
      const path = (r as unknown as Chunk).path;
      let score = r.score;
      if (neighbors?.has(path)) score *= 1.3;
      if (path === activePath) score *= 1.5;
      return { ...(r as unknown as Chunk), score };
    });
    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, topK);
  }

  /** Outlinks + backlinks of a note, from Obsidian's metadata cache. */
  private neighborSet(path: string): Set<string> {
    const resolved = this.app.metadataCache.resolvedLinks;
    const out = new Set<string>(Object.keys(resolved[path] ?? {}));
    for (const [src, targets] of Object.entries(resolved)) {
      if (targets[path]) out.add(src);
    }
    return out;
  }
}
