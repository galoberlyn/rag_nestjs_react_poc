import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Post,
  UploadedFile,
  UseInterceptors,
} from "@nestjs/common";
import { FileInterceptor } from "@nestjs/platform-express";
import { DocumentsService } from "./documents.service";

type Upload = {
  originalname: string;
  mimetype: string;
  buffer: Buffer;
  size: number;
};

@Controller("documents")
export class DocumentsController {
  constructor(private readonly documents: DocumentsService) {}

  @Get()
  list() {
    return this.documents.list();
  }

  @Post()
  @UseInterceptors(
    FileInterceptor("file", {
      limits: { fileSize: 8 * 1024 * 1024, fieldSize: 2 * 1024 * 1024 },
    }),
  )
  create(
    @UploadedFile() file: Upload | undefined,
    @Body() body: { title?: string; text?: string },
  ) {
    if (file && !isAllowed(file)) {
      throw new BadRequestException("Use a .txt, .md, or .pdf file");
    }
    return this.documents.create({
      title: body.title,
      text: body.text,
      file,
    });
  }

  @Delete(":id")
  remove(@Param("id") id: string) {
    return this.documents.remove(id);
  }
}

function isAllowed(file: Upload) {
  const name = file.originalname.toLowerCase();
  return (
    name.endsWith(".txt") ||
    name.endsWith(".md") ||
    name.endsWith(".pdf") ||
    file.mimetype === "application/pdf" ||
    file.mimetype.startsWith("text/")
  );
}
