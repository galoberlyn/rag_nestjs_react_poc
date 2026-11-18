import { Injectable } from "@nestjs/common";
import { DbService } from "../core/db.service";
import { LlamaService } from "../core/llama.service";

export type HistoryMessage = { role: "user" | "assistant"; content: string };

export type Source = {
  documentId: string;
  title: string;
  excerpt: string;
  score: number;
};

const TOP_K = 5;

@Injectable()
export class ChatService {
  constructor(
    private readonly db: DbService,
    private readonly llama: LlamaService,
  ) {}

  parseHistory(input: unknown): HistoryMessage[] {
    if (!Array.isArray(input)) return [];
    const messages: HistoryMessage[] = [];
    for (const item of input) {
      if (!item || typeof item !== "object") continue;
      const role = (item as { role?: unknown }).role;
      const content = (item as { content?: unknown }).content;
      if ((role !== "user" && role !== "assistant") || typeof content !== "string") continue;
      const trimmed = content.trim();
      if (!trimmed) continue;
      messages.push({ role, content: trimmed.slice(0, 4000) });
    }
    return messages.slice(-8);
  }

  async answer(question: string, history: HistoryMessage[], signal: AbortSignal) {
    const prior = [...history].reverse().find((message) => message.role === "user")?.content;
    const retrievalText = (prior ? `${prior}\n${question}` : question).slice(0, 2000);
    const [vector] = await this.llama.embed([this.llama.queryText(retrievalText)]);
    const result = await this.db.query<{
      document_id: string;
      title: string;
      content: string;
      score: number;
    }>(
      `SELECT d.id AS document_id, d.title, c.content,
              1 - (c.embedding <=> $1::halfvec) AS score
       FROM chunks c
       JOIN documents d ON d.id = c.document_id
       ORDER BY c.embedding <=> $1::halfvec
       LIMIT $2`,
      [`[${vector.join(",")}]`, TOP_K],
    );

    const ranked = result.rows.map((row) => ({ ...row, score: Number(row.score) }));
    const best = ranked[0]?.score ?? 0;
    const hits =
      best >= 0.3 ? ranked.filter((row) => row.score >= Math.max(0.3, best - 0.15)) : [];
    const sources: Source[] = hits.map((row) => ({
      documentId: row.document_id,
      title: row.title,
      excerpt: row.content.replace(/\s+/g, " ").slice(0, 220),
      score: Number(row.score),
    }));

    if (!hits.length) {
      const count = await this.db.query<{ n: number }>("SELECT count(*)::int AS n FROM documents");
      const text =
        count.rows[0].n === 0
          ? "Add a document on the left, then ask about it."
          : "I can't find that in the documents.";
      return { sources, stream: emptyStream(text) };
    }

    const context = hits
      .map((row, index) => `[${index + 1}] ${row.title}\n${row.content}`)
      .join("\n\n");
    const messages = [
      {
        role: "system",
        content:
          "You answer questions about the user's documents. Use only the excerpts in the context. If they do not contain the answer, say you cannot find it in the documents. Mention the document title when you use it. Write plain sentences, with no markdown.",
      },
      ...history,
      {
        role: "user",
        content: `Context:\n${context}\n\nQuestion: ${question}`,
      },
    ];

    return { sources, stream: this.llama.streamAnswer(messages, signal) };
  }
}

async function* emptyStream(text: string) {
  yield text;
}
