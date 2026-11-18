type Upload = {
  originalname: string;
  mimetype: string;
  buffer: Buffer;
};

export async function extractDocumentText(file: Upload): Promise<string> {
  const name = file.originalname.toLowerCase();
  const isPdf = name.endsWith(".pdf") || file.mimetype === "application/pdf";
  if (!isPdf) return file.buffer.toString("utf8");

  const { extractText, getDocumentProxy } = await import("unpdf");
  const pdf = await getDocumentProxy(new Uint8Array(file.buffer));
  const result = await extractText(pdf, { mergePages: true });
  return Array.isArray(result.text) ? result.text.join("\n\n") : String(result.text ?? "");
}
