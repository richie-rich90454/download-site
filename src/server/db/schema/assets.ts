import { sqliteTable, text, integer, index, primaryKey } from "drizzle-orm/sqlite-core";

/**
 * One cached asset file on disk.
 *
 * `sizeOnDisk` and `mtimeMs` exist so a cache hit is a single `stat` instead of a re-hash of the
 * whole file. They are the recorded fingerprint from download time; a mismatch against a fresh
 * `stat` means the file changed underneath us and triggers the authoritative hash.
 */
export const assetCache = sqliteTable(
    "asset_cache",
    {
        app: text("app").notNull(),
        version: text("version").notNull(),
        assetName: text("asset_name").notNull(),
        filePath: text("file_path").notNull(),
        size: integer("size").notNull(),
        checksum: text("checksum").notNull(),
        lastAccessedAt: integer("last_accessed_at").notNull(),
        createdAt: integer("created_at").notNull(),
        sizeOnDisk: integer("size_on_disk").notNull().default(0),
        mtimeMs: integer("mtime_ms").notNull().default(0)
    },
    function (table) {
        return [
            // One row per (app, version, asset). A re-download of the same asset updates in place
            // rather than failing on a duplicate, which is why this is an upsert target.
            primaryKey({ columns: [table.app, table.version, table.assetName] }),
            // Eviction walks oldest-access-first, so that ordering needs its own index.
            index("idx_asset_cache_access").on(table.lastAccessedAt),
            index("idx_asset_cache_created").on(table.createdAt)
        ];
    }
);

export type AssetCacheRow = typeof assetCache.$inferSelect;
export type NewAssetCacheRow = typeof assetCache.$inferInsert;
