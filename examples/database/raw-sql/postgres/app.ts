import { defineApp } from "@nosrv/core";

interface MessageRow extends Record<string, unknown> {
  id: string;
  text: string;
}

export default defineApp({
  requires: { db: true },
  async fetch(request, ctx) {
    const url = new URL(request.url);
    if (request.method === "GET" && url.pathname === "/environment") {
      return Response.json({ databaseUrlHidden: ctx.env.DATABASE_URL === undefined });
    }

    await ctx.db.sql.execute(`
      CREATE TABLE IF NOT EXISTS messages (
        id BIGSERIAL PRIMARY KEY,
        text TEXT NOT NULL
      )
    `);

    if (request.method === "POST") {
      const text = await request.text();
      if (!text.trim()) return new Response("Message is required", { status: 400 });
      await ctx.db.sql.execute("INSERT INTO messages (text) VALUES (?)", [text]);
      return new Response(null, { status: 201 });
    }

    if (request.method !== "GET") return new Response("Method not allowed", { status: 405 });
    const { rows } = await ctx.db.sql.query<MessageRow>(
      "SELECT id, text FROM messages ORDER BY id DESC LIMIT ?",
      [20],
    );
    return Response.json(rows);
  },
});
