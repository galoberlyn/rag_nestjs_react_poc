const TARGET = 1400;
const OVERLAP = 220;

/** Pack document text into short overlapping passages for retrieval. */
export function chunkText(raw: string): string[] {
  const text = raw
    .replace(/\r\n/g, "\n")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  if (!text) return [];

  const pieces: string[] = [];
  for (const paragraph of text.split(/\n\n+/)) {
    const part = paragraph.trim();
    if (!part) continue;
    if (part.length <= TARGET) {
      pieces.push(part);
      continue;
    }
    let start = 0;
    while (start < part.length) {
      let end = Math.min(start + TARGET, part.length);
      if (end < part.length) {
        const window = part.slice(start, end);
        const breakAt = Math.max(
          window.lastIndexOf(". "),
          window.lastIndexOf("\n"),
          window.lastIndexOf(" "),
        );
        if (breakAt > TARGET * 0.5) end = start + breakAt + 1;
      }
      const slice = part.slice(start, end).trim();
      if (slice) pieces.push(slice);
      if (end >= part.length) break;
      start = Math.max(end - OVERLAP, start + 1);
    }
  }

  const chunks: string[] = [];
  let current = "";
  for (const piece of pieces) {
    if (!current) {
      current = piece;
      continue;
    }
    if (current.length + 2 + piece.length <= TARGET) {
      current = `${current}\n\n${piece}`;
      continue;
    }
    chunks.push(current);
    const tail = current.slice(-OVERLAP).trim();
    const next = tail ? `${tail}\n\n${piece}` : piece;
    current = next.length > TARGET + OVERLAP ? piece : next;
  }
  if (current.trim()) chunks.push(current.trim());
  return chunks;
}
