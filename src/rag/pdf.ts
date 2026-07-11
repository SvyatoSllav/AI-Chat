// PDF text extraction using the pdf.js that Obsidian already ships (window.pdfjsLib).
// No bundled dependency — keeps main.js small. Returns extracted text, or "" if
// pdf.js isn't available / the PDF is image-only (scanned, no text layer).

interface PdfTextItem { str?: string }
interface PdfPage { getTextContent(): Promise<{ items: PdfTextItem[] }> }
interface PdfDoc { numPages: number; getPage(n: number): Promise<PdfPage> }

function pdfjs(): any {
  return (window as any).pdfjsLib || (window as any).pdfjs || null;
}

export function pdfSupported(): boolean {
  return !!pdfjs();
}

export async function extractPdfText(data: ArrayBuffer, maxPages = 200): Promise<string> {
  const lib = pdfjs();
  if (!lib?.getDocument) throw new Error("PDF reading needs Obsidian's built-in PDF viewer (update Obsidian).");
  const doc: PdfDoc = await lib.getDocument({ data: new Uint8Array(data) }).promise;
  const pages: string[] = [];
  const n = Math.min(doc.numPages, maxPages);
  for (let i = 1; i <= n; i++) {
    const page = await doc.getPage(i);
    const content = await page.getTextContent();
    const text = content.items.map((it) => it.str ?? "").join(" ").replace(/\s+\n/g, "\n").trim();
    if (text) pages.push(text);
  }
  return pages.join("\n\n");
}
