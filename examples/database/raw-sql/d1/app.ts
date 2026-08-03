import { defineApp } from "@nosrv/core";

interface MessageRow extends Record<string, unknown> {
  id: number;
  text: string;
  created_at: string;
}

export default defineApp({
  requires: { db: true },
  async fetch(request, ctx) {
    await ctx.db.sql.execute(`
      CREATE TABLE IF NOT EXISTS messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        text TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      )
    `);
    if (request.method === "POST") {
      const result = await ctx.db.sql.execute("INSERT INTO messages (text) VALUES (?)", [
        await request.text(),
      ]);
      return Response.json(result, { status: 201 });
    }
    return Response.json(
      (
        await ctx.db.sql.query<MessageRow>(
          "SELECT id, text, created_at FROM messages ORDER BY id DESC LIMIT 20",
        )
      ).rows,
    );
  },
});
