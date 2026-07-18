import { handleRequest } from "./router";

export { DirectoryDurableObject } from "./durable/directory";
export { RoomDurableObject } from "./durable/room";

export default {
  async fetch(request: Request, env: CloudflareEnv, ctx: ExecutionContext): Promise<Response> {
    return handleRequest(request, env, ctx);
  },
} satisfies ExportedHandler<CloudflareEnv>;
