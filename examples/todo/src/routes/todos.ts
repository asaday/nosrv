import { noContent, readJson, type Router } from "@nosrv/router";
import { listTodos } from "../database.ts";

type Requirements = { readonly db: true };

export function registerTodoRoutes(router: Router<Requirements>): void {
  router.get("/api/todos", async ({ ctx }) => Response.json(await listTodos(ctx.db)));

  router.post("/api/todos", async ({ request, ctx }) => {
    const body = await readJson<{ title?: unknown }>(request, { maxSize: 64 * 1024 });
    if (typeof body.title !== "string" || !body.title.trim())
      return Response.json({ error: "title is required" }, { status: 400 });
    const todo = {
      id: crypto.randomUUID(),
      title: body.title.trim(),
      createdAt: new Date().toISOString(),
    };
    await ctx.db.insert("todos", {
      id: todo.id,
      title: todo.title,
      completed: false,
      created_at: todo.createdAt,
    });
    return Response.json({ ...todo, completed: false }, { status: 201 });
  });

  router.patch("/api/todos/:id", async ({ request, ctx, params }) => {
    const body = await readJson<{ completed?: unknown }>(request, { maxSize: 64 * 1024 });
    if (typeof body.completed !== "boolean")
      return Response.json({ error: "completed must be boolean" }, { status: 400 });
    const result = await ctx.db.update(
      "todos",
      { completed: body.completed },
      { where: { id: params.id } },
    );
    return result.rowsAffected
      ? noContent()
      : Response.json({ error: "not found" }, { status: 404 });
  });

  router.delete("/api/todos/:id", async ({ ctx, params }) => {
    const result = await ctx.db.delete("todos", { where: { id: params.id } });
    return result.rowsAffected
      ? noContent()
      : Response.json({ error: "not found" }, { status: 404 });
  });
}
