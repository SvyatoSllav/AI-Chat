export interface Chunk {
  id: string;
  path: string;
  title: string;
  heading: string;
  text: string;
}

const MAX_CHUNK = 1600; // chars, ~400 tokens
const HARD_CAP = 8000; // docs/large-vault.md §3 — no unbounded strings

/** Markdown-aware chunking: split by headings, then by paragraphs. */
export function chunkMarkdown(path: string, content: string): Chunk[] {
  let body = content;
  if (body.startsWith("---")) {
    const end = body.indexOf("\n---", 3);
    if (end !== -1) body = body.slice(end + 4);
  }
  const title = path.replace(/\.md$/, "").split("/").pop() ?? path;

  const sections: { heading: string; lines: string[] }[] = [{ heading: "", lines: [] }];
  for (const line of body.split("\n")) {
    const m = /^#{1,6}\s+(.*)/.exec(line);
    if (m) sections.push({ heading: m[1], lines: [] });
    else sections[sections.length - 1].lines.push(line);
  }

  const chunks: Chunk[] = [];
  let ord = 0;
  for (const sec of sections) {
    const text = sec.lines.join("\n").trim();
    if (!text) continue;
    let buf = "";
    const flush = () => {
      const t = buf.trim();
      if (t) chunks.push({ id: `${path}#${ord++}`, path, title, heading: sec.heading, text: t.slice(0, HARD_CAP) });
      buf = "";
    };
    for (const p of text.split(/\n\s*\n/)) {
      if (buf.length + p.length > MAX_CHUNK && buf) flush();
      buf += p + "\n\n";
      if (buf.length > MAX_CHUNK * 2) flush(); // giant single paragraph
    }
    flush();
  }
  return chunks;
}
