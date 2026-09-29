/**
 * A dependency-free PDF 1.4 writer for the inspection export (design §1.6):
 * text and horizontal rules only, the standard-14 Helvetica and
 * Helvetica-Bold, US Letter, word-wrapped, multi-page. The Worker bundle
 * carries no PDF library and the output is byte-stable for the same input,
 * so the export's SHA-256 identifies its content. (Adapted from arcdesk's
 * decision-letter writer.)
 */

export interface PdfBlock {
  text: string;
  /** Bold heading line(s). */
  bold?: boolean | undefined;
  /** Font size in points; defaults to 11. */
  size?: number | undefined;
  /** Extra space after the block, in points; defaults to 8. */
  after?: number | undefined;
  /** Draw a thin horizontal rule instead of text. */
  rule?: boolean | undefined;
}

const PAGE_W = 612;
const PAGE_H = 792;
const MARGIN = 54;
const LINE = 1.35;

// Helvetica advance widths (per 1000 em) for printable ASCII, 0x20–0x7e, from
// the standard AFM. A close-enough measure for wrapping; anything else is 556.
const HELVETICA_WIDTHS: readonly number[] = [
  278, 278, 355, 556, 556, 889, 667, 191, 333, 333, 389, 584, 278, 333, 278, 278,
  556, 556, 556, 556, 556, 556, 556, 556, 556, 556, 278, 278, 584, 584, 584, 556,
  1015, 667, 667, 722, 722, 667, 611, 778, 722, 278, 500, 667, 556, 833, 722, 778,
  667, 778, 722, 667, 611, 722, 667, 944, 667, 667, 611, 278, 278, 278, 469, 556,
  333, 556, 556, 500, 556, 556, 278, 556, 556, 222, 222, 500, 222, 833, 556, 556,
  556, 556, 333, 500, 278, 556, 500, 722, 500, 500, 500, 334, 260, 334, 584,
];

function widthOf(text: string, size: number, bold: boolean): number {
  let w = 0;
  for (const ch of text) {
    const code = ch.codePointAt(0)!;
    w += code >= 0x20 && code <= 0x7e ? HELVETICA_WIDTHS[code - 0x20]! : 556;
  }
  return (w / 1000) * size * (bold ? 1.05 : 1);
}

/** Unicode → WinAnsiEncoding byte, for the characters a letter plausibly holds. */
const WIN_ANSI: Record<string, number> = {
  "—": 0x97, "–": 0x96, "‘": 0x91, "’": 0x92, "“": 0x93, "”": 0x94,
  "•": 0x95, "…": 0x85, "€": 0x80,
};

/** Escape a line into a PDF literal string, 7-bit clean (octal escapes above 0x7e). */
function pdfString(text: string): string {
  let out = "(";
  for (const ch of text) {
    let code = WIN_ANSI[ch] ?? ch.codePointAt(0)!;
    if (code > 0xff) code = 0x3f; // '?'
    if (ch === "\\" || ch === "(" || ch === ")") out += "\\" + ch;
    else if (code < 0x20 || code > 0x7e) out += "\\" + code.toString(8).padStart(3, "0");
    else out += ch;
  }
  return out + ")";
}

function wrap(text: string, size: number, bold: boolean, maxWidth: number): string[] {
  const lines: string[] = [];
  for (const paragraph of text.split("\n")) {
    const words = paragraph.split(/\s+/).filter((w) => w.length > 0);
    if (words.length === 0) {
      lines.push("");
      continue;
    }
    let line = "";
    for (const word of words) {
      const candidate = line ? `${line} ${word}` : word;
      if (widthOf(candidate, size, bold) <= maxWidth || !line) line = candidate;
      else {
        lines.push(line);
        line = word;
      }
    }
    lines.push(line);
  }
  return lines;
}

/** Render blocks into a complete PDF file. */
export function renderPdf(blocks: readonly PdfBlock[], meta: { title: string }): Uint8Array {
  const pages: string[] = [];
  let ops: string[] = [];
  let y = PAGE_H - MARGIN;
  const flush = () => {
    pages.push(ops.join("\n"));
    ops = [];
    y = PAGE_H - MARGIN;
  };

  for (const block of blocks) {
    if (block.rule) {
      if (y - 6 < MARGIN) flush();
      y -= 4;
      ops.push(`0.5 w ${MARGIN} ${y.toFixed(2)} m ${PAGE_W - MARGIN} ${y.toFixed(2)} l S`);
      y -= block.after ?? 6;
      continue;
    }
    const size = block.size ?? 11;
    const bold = block.bold ?? false;
    const lead = size * LINE;
    for (const line of wrap(block.text, size, bold, PAGE_W - 2 * MARGIN)) {
      if (y - lead < MARGIN) flush();
      y -= lead;
      if (line) ops.push(`BT /${bold ? "F2" : "F1"} ${size} Tf ${MARGIN} ${y.toFixed(2)} Td ${pdfString(line)} Tj ET`);
    }
    y -= block.after ?? 8;
  }
  if (ops.length > 0 || pages.length === 0) flush();

  // Objects: 1 catalog, 2 pages, 3 F1, 4 F2, 5 info, then (page, content) pairs.
  const objects: string[] = [];
  const pageIds = pages.map((_, i) => 6 + i * 2);
  objects[1] = "<< /Type /Catalog /Pages 2 0 R >>";
  objects[2] = `<< /Type /Pages /Kids [${pageIds.map((id) => `${id} 0 R`).join(" ")}] /Count ${pages.length} >>`;
  objects[3] = "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>";
  objects[4] = "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>";
  objects[5] = `<< /Title ${pdfString(meta.title)} /Producer (Leakbook) >>`;
  pages.forEach((content, i) => {
    const pageId = 6 + i * 2;
    objects[pageId] =
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${PAGE_W} ${PAGE_H}] ` +
      `/Resources << /Font << /F1 3 0 R /F2 4 0 R >> >> /Contents ${pageId + 1} 0 R >>`;
    objects[pageId + 1] = `<< /Length ${content.length} >>\nstream\n${content}\nendstream`;
  });

  // Every byte below is 7-bit ASCII, so string length is byte length.
  let body = "%PDF-1.4\n";
  const offsets: number[] = [];
  for (let id = 1; id < objects.length; id++) {
    offsets[id] = body.length;
    body += `${id} 0 obj\n${objects[id]}\nendobj\n`;
  }
  const xref = body.length;
  body += `xref\n0 ${objects.length}\n0000000000 65535 f \n`;
  for (let id = 1; id < objects.length; id++) body += `${String(offsets[id]).padStart(10, "0")} 00000 n \n`;
  body += `trailer\n<< /Size ${objects.length} /Root 1 0 R /Info 5 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return new TextEncoder().encode(body);
}
