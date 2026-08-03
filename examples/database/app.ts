import { defineApp } from "@nosrv/core";

interface Message extends Record<string, unknown> {
  id: string;
  text: string;
  created_at: string;
}

export default defineApp({
  requires: { db: true },
  async initialize(ctx) {
    await ctx.db.ensureTable("portable_messages", {
      id: { type: "text", primaryKey: true },
      text: { type: "text", required: true },
      created_at: { type: "timestamp", required: true },
    });
    await ctx.db.ensureIndex("portable_messages_created_at", "portable_messages", {
      fields: ["created_at"],
    });
  },

  async fetch(request, ctx) {
    if (request.method === "POST") {
      const text = await request.text();
      if (!text.trim()) return new Response("Message is required", { status: 400 });
      const message: Message = {
        id: crypto.randomUUID(),
        text: text.trim(),
        created_at: new Date().toISOString(),
      };
      await ctx.db.insert("portable_messages", {
        id: message.id,
        text: message.text,
        created_at: message.created_at,
      });
      return Response.json(message, { status: 201 });
    }

    if (request.method === "DELETE") {
      const id = new URL(request.url).searchParams.get("id");
      if (!id) return new Response("Message id is required", { status: 400 });
      const result = await ctx.db.delete("portable_messages", { where: { id } });
      return new Response(null, { status: result.rowsAffected ? 204 : 404 });
    }

    if (request.method !== "GET") return new Response("Method not allowed", { status: 405 });
    return Response.json(
      await ctx.db.select<Message>("portable_messages", {
        fields: ["id", "text", "created_at"],
        orderBy: [{ field: "created_at", direction: "desc" }],
        limit: 20,
      }),
    );
  },
});
