import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { chunkText } from "../core/chunk";
import { DbService } from "../core/db.service";
import { LlamaService } from "../core/llama.service";
import { extractDocumentText } from "./extract";

const MAX_CHUNKS = 400;

export type StoredDocument = {
  id: string;
  title: string;
  createdAt: string;
  chunkCount: number;
};

type Upload = {
  originalname: string;
  mimetype: string;
  buffer: Buffer;
};

@Injectable()
export class DocumentsService {
  constructor(
    private readonly db: DbService,
    private readonly llama: LlamaService,
  ) {}

  async list(): Promise<StoredDocument[]> {
    const result = await this.db.query<{
      id: string;
      title: string;
      created_at: Date;
      chunk_count: number;
    }>(`
      SELECT d.id, d.title, d.created_at, count(c.id)::int AS chunk_count
      FROM documents d
      LEFT JOIN chunks c ON c.document_id = d.id
      GROUP BY d.id
      ORDER BY d.created_at DESC
    `);
    return result.rows.map((row) => ({
      id: row.id,
      title: row.title,
      createdAt: row.created_at.toISOString(),
      chunkCount: row.chunk_count,
    }));
  }

  async create(input: { title?: string; text?: string; file?: Upload }) {
    const fromFile = input.file ? await extractDocumentText(input.file) : "";
    const pasted = input.text?.trim() ?? "";
    const text = [fromFile.trim(), pasted].filter(Boolean).join("\n\n");
    if (!text) {
      throw new BadRequestException("Add a file or paste some text");
    }

    const title =
      input.title?.trim() ||
      input.file?.originalname.replace(/\.[^.]+$/, "") ||
      firstLine(text);
    const chunks = chunkText(text);
    if (!chunks.length) throw new BadRequestException("That document has no readable text");
    if (chunks.length > MAX_CHUNKS) {
      throw new BadRequestException(
        `That document is too long (${chunks.length} passages). Split it under ${MAX_CHUNKS}.`,
      );
    }

    const vectors = await this.llama.embed(chunks);
    const client = await this.db.pool.connect();
    try {
      await client.query("BEGIN");
      const inserted = await client.query<{ id: string }>(
        "INSERT INTO documents (title) VALUES ($1) RETURNING id",
        [title.slice(0, 200)],
      );
      const id = inserted.rows[0].id;
      for (let index = 0; index < chunks.length; index += 1) {
        await client.query(
          `INSERT INTO chunks (document_id, chunk_index, content, embedding)
           VALUES ($1, $2, $3, $4::halfvec)`,
          [id, index, chunks[index], `[${vectors[index].join(",")}]`],
        );
      }
      await client.query("COMMIT");
      return { id, title: title.slice(0, 200), chunkCount: chunks.length };
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async remove(id: string) {
    if (!/^[0-9a-f-]{36}$/i.test(id)) throw new BadRequestException("Invalid document id");
    const result = await this.db.query("DELETE FROM documents WHERE id = $1 RETURNING id", [id]);
    if (!result.rowCount) throw new NotFoundException("Document not found");
    return { id };
  }
}

function firstLine(text: string) {
  const line = text.split("\n").find((item) => item.trim())?.trim() ?? "Untitled";
  return line.slice(0, 80);
}
