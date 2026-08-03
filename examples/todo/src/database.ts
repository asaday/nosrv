import type { AppContextFor, Database } from "@nosrv/core";
export interface Todo extends Record<string, unknown> {
  id: string;
  title: string;
  completed: boolean;
  created_at: string;
}
export async function prepareDatabase({ db }: AppContextFor<{ db: true }>): Promise<void> {
  await db.ensureTable("todos", {
    id: { type: "text", primaryKey: true },
    title: { type: "text", required: true },
    completed: { type: "boolean", required: true, default: false },
    created_at: { type: "timestamp", required: true },
  });
  await db.ensureIndex("todos_created_at", "todos", { fields: ["created_at"] });
}
export async function listTodos(db: Database): Promise<Todo[]> {
  return await db.select<Todo>("todos", {
    fields: ["id", "title", "completed", "created_at"],
    orderBy: [{ field: "created_at", direction: "desc" }],
    limit: 100,
  });
}
