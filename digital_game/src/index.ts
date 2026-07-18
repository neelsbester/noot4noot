import { DurableObject } from "cloudflare:workers";

export class DirectoryDurableObject extends DurableObject<CloudflareEnv> {
  ping(): string {
    return "directory-ready";
  }
}

export class RoomDurableObject extends DurableObject<CloudflareEnv> {
  ping(): string {
    return "room-ready";
  }
}

export default {
  fetch(): Response {
    return Response.json({ error: "Not implemented", code: "not_implemented" }, { status: 501 });
  },
} satisfies ExportedHandler<CloudflareEnv>;
