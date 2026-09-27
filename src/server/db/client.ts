import { drizzle, type BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import BetterSqlite3 from "better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import * as assets from "./schema/assets.js";
import * as metadata from "./schema/metadata.js";

const schema = {
    assetCache: assets.assetCache,
    appState: metadata.appState,
    releases: metadata.releases
};

/**
 * `$client` is the raw better-sqlite3 handle. It is part of `drizzle()`'s return type but not of
 * `BetterSQLite3Database`, so it is named here rather than reached for through a cast at each
 * close site.
 */
export type CacheDatabase = BetterSQLite3Database<typeof schema> & { $client: BetterSqlite3.Database };

/**
 * The subset of the database a write helper needs, so the same helper works inside a transaction
 * and outside one. A transaction hands back a different concrete type, and naming the full
 * database here would make every helper transactional-only.
 */
export type CacheWriter = Pick<CacheDatabase, "insert" | "update" | "delete" | "select">;

export interface OpenDatabaseOptions {
    /** Absolute path to the .db file. */
    filePath: string;
}

/**
 * Opens a cache database with Drizzle and brings it up to the current schema.
 *
 * WAL is set before anything else touches the file. Without it better-sqlite3 falls back to a
 * rollback journal, where a writer blocks every reader - fatal for a read-heavy release path that
 * writes on every cache refresh.
 *
 * `busy_timeout` covers the reverse case: a reader that arrives while a write holds the lock waits
 * instead of failing the request.
 */
export function openCacheDatabase(options: OpenDatabaseOptions): CacheDatabase {
    fs.mkdirSync(path.dirname(options.filePath), { recursive: true });
    try {
        return open(options.filePath);
    } catch (err) {
        // A file written before these migrations exist cannot be migrated in place. Both databases
        // hold only derived data - a mirror of GitHub's releases and files already downloaded - so
        // the right move is to throw the file away and rebuild, not to fail the boot and leave an
        // operator to work out that a cache is what broke.
        if (!isUnreadableSchema(err)) {
            throw err;
        }
        removeDatabaseFiles(options.filePath);
        return open(options.filePath);
    }
}

function open(filePath: string): CacheDatabase {
    const sqlite = new BetterSqlite3(filePath);
    try {
        sqlite.pragma("journal_mode = WAL");
        sqlite.pragma("busy_timeout = 5000");
        const db = drizzle(sqlite, { schema: schema });
        migrate(db, { migrationsFolder: migrationsFolder() });
        return db;
    } catch (err) {
        // The handle has to go before the caller can delete the file. On Windows an open handle
        // blocks the delete, and on every platform it is a connection this process will never use.
        sqlite.close();
        throw err;
    }
}

/**
 * True only for "this file has tables I do not understand", never for I/O or corruption faults.
 *
 * Drizzle wraps the driver's message in "Failed to run the query '<sql>'" and keeps the actual
 * reason - "table app_state already exists" - on `cause`. Matching on the wrapper finds nothing,
 * so the chain is walked rather than the first frame guessed at.
 */
function isUnreadableSchema(err: unknown): boolean {
    const seen = new Set<unknown>();
    let current: unknown = err;
    while (current instanceof Error && !seen.has(current)) {
        if (current.message.indexOf("already exists") >= 0) {
            return true;
        }
        seen.add(current);
        current = current.cause;
    }
    return false;
}

/**
 * Deletes a database and its WAL sidecars.
 *
 * The `-wal` and `-shm` files must go with it: a stale write-ahead log replayed against a fresh
 * database is how a cache ends up serving rows for a schema that no longer exists.
 */
function removeDatabaseFiles(filePath: string): void {
    const suffixes = ["", "-wal", "-shm"];
    for (let i = 0; i < suffixes.length; i = i + 1) {
        const suffix = suffixes[i];
        try {
            fs.rmSync(filePath + suffix, { force: true });
        } catch {
            // Nothing useful to do: the retry is the real recovery, and if that also fails the
            // original error is what the operator needs to see.
        }
    }
}

let cachedMigrationsFolder: string | undefined;

/**
 * Resolves the migrations directory relative to this module rather than the process cwd.
 *
 * The server runs from dist/ while drizzle-kit generates into the repo root, and tests run from
 * the repo root while importing from src/. A cwd-relative path works in one of those and throws
 * in the other two.
 */
export function migrationsFolder(): string {
    if (cachedMigrationsFolder === undefined) {
        const here = path.dirname(fileURLToPath(import.meta.url));
        cachedMigrationsFolder = path.resolve(here, "..", "..", "..", "drizzle");
    }
    return cachedMigrationsFolder;
}

export { schema };
