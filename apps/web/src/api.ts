export type DocumentRecord = {
  id: string;
  title: string;
  createdAt: string;
  chunkCount: number;
};

export type Source = {
  documentId: string;
  title: string;
  excerpt: string;
  score: number;
};

export type ChatEvent =
  | { type: "sources"; sources: Source[] }
  | { type: "token"; content: string }
  | { type: "done" }
  | { type: "error"; message: string };

export async function listDocuments(): Promise<DocumentRecord[]> {
  const response = await fetch("/api/documents");
  if (!response.ok) throw new Error(await readError(response));
  return response.json() as Promise<DocumentRecord[]>;
}

export async function createDocument(input: {
  title: string;
  text: string;
  file: File | null;
}): Promise<{ id: string; title: string; chunkCount: number }> {
  const body = new FormData();
  if (input.title.trim()) body.set("title", input.title.trim());
  if (input.text.trim()) body.set("text", input.text.trim());
  if (input.file) body.set("file", input.file);
  const response = await fetch("/api/documents", { method: "POST", body });
  if (!response.ok) throw new Error(await readError(response));
  return response.json() as Promise<{ id: string; title: string; chunkCount: number }>;
}

export async function deleteDocument(id: string) {
  const response = await fetch(`/api/documents/${id}`, { method: "DELETE" });
  if (!response.ok) throw new Error(await readError(response));
}

export async function streamChat(
  message: string,
  history: { role: "user" | "assistant"; content: string }[],
  onEvent: (event: ChatEvent) => void,
  signal: AbortSignal,
) {
  const response = await fetch("/api/chat", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ message, history }),
    signal,
  });
  if (!response.ok || !response.body) throw new Error(await readError(response));

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const parts = buffer.split("\n\n");
    buffer = parts.pop() ?? "";
    for (const part of parts) {
      const line = part.split("\n").find((item) => item.startsWith("data: "));
      if (!line) continue;
      onEvent(JSON.parse(line.slice(6)) as ChatEvent);
    }
  }
}

async function readError(response: Response) {
  try {
    const payload = (await response.json()) as { message?: string | string[] };
    if (Array.isArray(payload.message)) return payload.message.join(" ");
    if (payload.message) return payload.message;
  } catch {
    /* body was not JSON */
  }
  return `Request failed (${response.status})`;
}
