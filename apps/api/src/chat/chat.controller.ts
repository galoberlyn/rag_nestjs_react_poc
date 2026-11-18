import { Body, Controller, Post, Res } from "@nestjs/common";
import type { Response } from "express";
import { ChatService } from "./chat.service";

@Controller("chat")
export class ChatController {
  constructor(private readonly chat: ChatService) {}

  @Post()
  async create(
    @Body() body: { message?: unknown; history?: unknown },
    @Res() res: Response,
  ) {
    const message = typeof body.message === "string" ? body.message.trim() : "";
    if (!message) {
      res.status(400).json({ message: "Message is required" });
      return;
    }
    if (message.length > 4000) {
      res.status(400).json({ message: "Message is too long" });
      return;
    }

    const history = this.chat.parseHistory(body.history);
    const abort = new AbortController();
    res.on("close", () => abort.abort());

    res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
    res.setHeader("Cache-Control", "no-cache, no-transform");
    res.setHeader("Connection", "keep-alive");
    res.flushHeaders();

    const send = (payload: unknown) => {
      res.write(`data: ${JSON.stringify(payload)}\n\n`);
    };

    try {
      const { sources, stream } = await this.chat.answer(message, history, abort.signal);
      send({ type: "sources", sources });
      for await (const token of stream) {
        if (abort.signal.aborted) break;
        send({ type: "token", content: token });
      }
      send({ type: "done" });
    } catch (error) {
      if (abort.signal.aborted) return;
      const messageText =
        error instanceof Error ? error.message : "Something went wrong while answering";
      send({ type: "error", message: messageText });
    } finally {
      res.end();
    }
  }
}
