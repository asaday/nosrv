import { HttpError, noContent, readForm, type Router } from "@nosrv/core";
import { findEntry, listEntries } from "../database.ts";

type Requirements = { readonly db: true; readonly storage: true };
const userId = (user: { id: string } | null | undefined) => user?.id ?? "local-demo-user";

export function registerEntryRoutes(router: Router<Requirements>): void {
  router.get("/api/entries", async ({ ctx }) => {
    const owner = userId(ctx.user);
    return Response.json({ userId: owner, entries: await listEntries(ctx.db, owner) });
  });

  router.post("/api/entries", async ({ request, ctx }) => {
    const form = await readForm(request, { maxSize: 11 * 1024 * 1024 });
    const body = form.text("body", { required: true })!;
    const photo = form.file("photo", {
      required: true,
      accept: ["image/*"],
      maxSize: 10 * 1024 * 1024,
    });
    const owner = userId(ctx.user);
    const id = crypto.randomUUID();
    const key = `users/${owner}/entries/${id}`;
    await ctx.storage.put(key, photo.stream(), { contentType: photo.type });
    try {
      await ctx.db.insert("diary_entries", {
        id,
        user_id: owner,
        body: body.trim(),
        photo_key: key,
        created_at: new Date().toISOString(),
      });
    } catch (error) {
      await ctx.storage.delete(key);
      throw error;
    }
    return Response.json({ id }, { status: 201 });
  });

  router.get("/api/photos/:id", async ({ ctx, params }) => {
    const entry = await findEntry(ctx.db, params.id, userId(ctx.user));
    if (!entry) throw new HttpError(404, "Entry not found");
    const photo = await ctx.storage.get(entry.photo_key);
    if (!photo) throw new HttpError(404, "Photo not found");
    return new Response(photo.body, {
      headers: {
        "content-type": photo.metadata.contentType ?? "application/octet-stream",
        "cache-control": "private, max-age=60",
      },
    });
  });

  router.delete("/api/entries/:id", async ({ ctx, params }) => {
    const owner = userId(ctx.user);
    const entry = await findEntry(ctx.db, params.id, owner);
    if (!entry) throw new HttpError(404, "Entry not found");
    await ctx.db.delete("diary_entries", { where: { id: params.id, user_id: owner } });
    await ctx.storage.delete(entry.photo_key);
    return noContent();
  });
}
