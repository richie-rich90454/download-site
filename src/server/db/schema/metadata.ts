import { sqliteTable, text, integer, blob, index, primaryKey } from "drizzle-orm/sqlite-core";

/**
 * One release per app, stored as a msgpack blob.
 *
 * The blob is the record; `publishedAt` and `prerelease` are promoted to real columns so that
 * "newest stable" and "newest anything" are indexed reads instead of a full decode-and-sort of the
 * app's entire history on every updater poll.
 */
export const releases = sqliteTable(
    "releases",
    {
        app: text("app").notNull(),
        tag: text("tag").notNull(),
        // blob, not text: this is msgpack, and declaring it as text would invite someone to
        // compare or index it as a string.
        data: blob("data", { mode: "buffer" }).notNull(),
        etag: text("etag"),
        publishedAt: integer("published_at").notNull().default(0),
        prerelease: integer("prerelease", { mode: "boolean" }).notNull().default(false),
        fetchedAt: integer("fetched_at").notNull(),
        expiresAt: integer("expires_at").notNull()
    },
    function (table) {
        return [
            primaryKey({ columns: [table.app, table.tag] }),
            index("idx_releases_expires").on(table.expiresAt),
            // Serves both the newest-first lookup and the paged listing, so one index covers both
            // instead of scanning every row for an app and sorting in memory.
            index("idx_releases_latest").on(table.app, table.publishedAt)
        ];
    }
);

/**
 * One small row per app holding the answer to "what is the newest release".
 *
 * Without this, getLatestRelease had to decode an app's whole history and sort it. With it, the
 * hot path is one row read plus one primary-key read. Stable and beta are tracked separately so
 * moving a channel is a pointer swap rather than a re-scan.
 */
export const appState = sqliteTable("app_state", {
    app: text("app").primaryKey(),
    latestTag: text("latest_tag"),
    latestBetaTag: text("latest_beta_tag"),
    listEtag: text("list_etag"),
    updatedAt: integer("updated_at").notNull().default(0)
});

export type ReleaseRow = typeof releases.$inferSelect;
export type NewReleaseRow = typeof releases.$inferInsert;
export type AppStateRow = typeof appState.$inferSelect;
