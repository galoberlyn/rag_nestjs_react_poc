import { Injectable, ServiceUnavailableException } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";

const QUERY_TASK =
  "Given a web search query, retrieve relevant passages that answer the query";

type EmbeddingResponse = {
  data?: { index: number; embedding: number[] }[];
};

@Injectable()
export class LlamaService {
  private readonly llmBase: string;
  private readonly embedBase: string;

  constructor(config: ConfigService) {
    this.llmBase = (
      config.get<string>("LLM_BASE_URL") ?? "http://127.0.0.1:8080/v1"
    ).replace(/\/$/, "");
    this.embedBase = (
      config.get<string>("EMBED_BASE_URL") ?? "http://127.0.0.1:8081/v1"
    ).replace(/\/$/, "");
  }

  /** Qwen3-Embedding expects an instruction on queries and raw text on passages. */
  queryText(question: string) {
    return `Instruct: ${QUERY_TASK}\nQuery:${question}`;
  }

  async embed(texts: string[]): Promise<number[][]> {
    const vectors: number[][] = [];
    const batchSize = 4;
    for (let i = 0; i < texts.length; i += batchSize) {
      const batch = texts.slice(i, i + batchSize);
      const response = await fetch(`${this.embedBase}/embeddings`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ input: batch }),
      }).catch(() => {
        throw new ServiceUnavailableException(
          "Embedding server at localhost:8081 is not responding",
        );
      });
      if (!response.ok) {
        const detail = await response.text();
        throw new ServiceUnavailableException(
          `Embedding failed (${response.status}): ${detail.slice(0, 240)}`,
        );
      }
      const payload = (await response.json()) as EmbeddingResponse;
      const ordered = [...(payload.data ?? [])].sort((a, b) => a.index - b.index);
      if (ordered.length !== batch.length) {
        throw new ServiceUnavailableException("Embedding server returned an unexpected payload");
      }
      for (const item of ordered) {
        if (item.embedding.length !== 2560) {
          throw new ServiceUnavailableException(
            `Expected 2560-dimension embeddings, got ${item.embedding.length}`,
          );
        }
        vectors.push(item.embedding);
      }
    }
    return vectors;
  }

  async *streamAnswer(
    messages: { role: string; content: string }[],
    signal: AbortSignal,
  ): AsyncGenerator<string> {
    const response = await fetch(`${this.llmBase}/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      signal,
      body: JSON.stringify({
        messages,
        stream: true,
        temperature: 0.2,
        max_tokens: 700,
        chat_template_kwargs: { enable_thinking: false },
      }),
    }).catch((error: unknown) => {
      if (error instanceof Error && error.name === "AbortError") throw error;
      throw new ServiceUnavailableException(
        "Text model at localhost:8080 is not responding",
      );
    });

    if (!response.ok || !response.body) {
      const detail = await response.text();
      throw new ServiceUnavailableException(
        `Text model failed (${response.status}): ${detail.slice(0, 240)}`,
      );
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    const filter = new ThinkFilter();
    let buffer = "";

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed.startsWith("data:")) continue;
        const data = trimmed.slice(5).trim();
        if (!data || data === "[DONE]") continue;
        let content = "";
        try {
          const json = JSON.parse(data) as {
            choices?: { delta?: { content?: string } }[];
          };
          content = json.choices?.[0]?.delta?.content ?? "";
        } catch {
          continue;
        }
        const visible = filter.push(content);
        if (visible) yield visible;
      }
    }
    const rest = filter.flush();
    if (rest) yield rest;
  }
}

/** Drops Qwen <think> blocks when a token stream splits the tags. */
class ThinkFilter {
  private pending = "";
  private skipping = false;

  push(token: string): string {
    this.pending += token;
    let out = "";
    while (this.pending.length) {
      if (this.skipping) {
        const end = this.pending.indexOf("</think>");
        if (end === -1) {
          if (this.pending.length > 16) this.pending = this.pending.slice(-16);
          break;
        }
        this.pending = this.pending.slice(end + "</think>".length).replace(/^\n+/, "");
        this.skipping = false;
        continue;
      }
      const start = this.pending.indexOf("<think>");
      if (start === -1) {
        const partial = this.pending.lastIndexOf("<");
        if (partial !== -1 && "<think>".startsWith(this.pending.slice(partial))) {
          out += this.pending.slice(0, partial);
          this.pending = this.pending.slice(partial);
          break;
        }
        out += this.pending;
        this.pending = "";
        break;
      }
      out += this.pending.slice(0, start);
      this.pending = this.pending.slice(start + "<think>".length);
      this.skipping = true;
    }
    return out;
  }

  flush() {
    if (this.skipping) {
      this.pending = "";
      return "";
    }
    const rest = this.pending;
    this.pending = "";
    return rest;
  }
}
