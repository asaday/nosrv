import type { AppContextFor, Database } from "@nosrv/core";
export interface Entry extends Record<string, unknown> {
  id: string;
  body: string;
  photo_key: string;
  created_at: string;
}
export async function prepareDatabase({ db }: AppContextFor<{ db: true }>): Promise<void> {
  await db.ensureTable("diary_entries", {
    id: { type: "text", primaryKey: true },
    user_id: { type: "text", required: true },
    body: { type: "text", required: true },
    photo_key: { type: "text", required: true },
    created_at: { type: "timestamp", required: true },
  });
  await db.ensureIndex("diary_entries_user_created", "diary_entries", {
    fields: ["user_id", "created_at"],
  });
}
export async function listEntries(db: Database, userId: string): Promise<Entry[]> {
  return await db.select<Entry>("diary_entries", {
    fields: ["id", "body", "photo_key", "created_at"],
    where: { user_id: userId },
    orderBy: [{ field: "created_at", direction: "desc" }],
    limit: 50,
  });
}
export async function findEntry(
  db: Database,
  id: string,
  userId: string,
): Promise<Entry | undefined> {
  return (
    await db.select<Entry>("diary_entries", {
      fields: ["id", "body", "photo_key", "created_at"],
      where: { id, user_id: userId },
      limit: 1,
    })
  )[0];
}
