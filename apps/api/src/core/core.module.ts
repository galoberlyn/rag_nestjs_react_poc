import { Global, Module } from "@nestjs/common";
import { DbService } from "./db.service";
import { LlamaService } from "./llama.service";

@Global()
@Module({
  providers: [DbService, LlamaService],
  exports: [DbService, LlamaService],
})
export class CoreModule {}
