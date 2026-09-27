import * as fs from "node:fs";
import * as path from "node:path";
import Database from "better-sqlite3";
import * as msgpackr from "msgpackr";
import * as types from "../../shared/types.js";
import * as logger from "../logging/logger.js";

export interface MetadataCacheService {
    getReleases(app: string, options?: GetReleasesOptions): ReleasesCacheEntry | undefined;
    getReleaseByTag(app: string, tag: string): ReleaseCacheEntry | undefined;
    getLatestRelease(app: string, includePrerelease: boolean): ReleaseCacheEntry | undefined;
    getReleasePage(app: string, limit: number, offset: number, includePrerelease: boolean): types.Release[];
    setReleases(app: string, releases: types.Release[], etag: string | undefined, ttlSeconds: number): void;
    setRelease(app: string, tag: string, release: types.Release, etag: string | undefined, ttlSeconds: number): void;
    invalidateApp(app: string): void;
    invalidateTag(app: string, tag: string): void;
    invalidateAll(): void;
    close(): void;
}

export interface GetReleasesOptions {
    includePrerelease?: boolean;
}

export interface ReleasesCacheEntry {
    releases: types.Release[];
    etag: string | undefined;
    expiresAt: number;
}

export interface ReleaseCacheEntry {
    release: types.Release;
    etag: string | undefined;
    expiresAt: number;
}

interface ReleaseRow {
    tag: string;
    data: Buffer;
    etag: string | null;
    expires_at: number;
}

interface ReleaseByTagRow {
    data: Buffer;
    etag: string | null;
    expires_at: number;
}

interface DataRow {
    data: Buffer;
    etag: string | null;
    expires_at: number;
}

interface AppStateRow {
    latest_tag: string | null;
    latest_beta_tag: string | null;
}

export class SqliteMetadataCacheService implements MetadataCacheService {
    private readonly db: Database.Database;
    private readonly logger: logger.Logger;
    private readonly getAllStmt: Database.Statement<[string]>;
    private readonly getByTagStmt: Database.Statement<[string, string]>;
    private readonly insertStmt: Database.Statement<
        [string, string, Buffer, string | null, number, number, number, number]
    >;
    private readonly updateStmt: Database.Statement<
        [Buffer, string | null, number, number, number, number, string, string]
    >;
    private readonly invalidateAppStmt: Database.Statement<[string]>;
    private readonly invalidateTagStmt: Database.Statement<[string, string]>;
    private readonly invalidateAllStmt: Database.Statement<[]>;
    private readonly existsStmt: Database.Statement<[string, string]>;
    private readonly getPointerStmt: Database.Statement<[string]>;
    private readonly upsertPointerStmt: Database.Statement<[string, string | null, string | null, number]>;
    private readonly newestStableStmt: Database.Statement<[string]>;
    private readonly newestAnyStmt: Database.Statement<[string]>;
    private readonly pageStableStmt: Database.Statement<[string, number, number]>;
    private readonly pageAnyStmt: Database.Statement<[string, number, number]>;

    constructor(cacheDir: string, loggerInstance: logger.Logger) {
        if (!fs.existsSync(cacheDir)) {
            fs.mkdirSync(cacheDir, { recursive: true });
        }
        const dbPath = path.join(cacheDir, "metadata.db");
        this.db = new Database(dbPath);
        this.logger = loggerInstance;
        this.migrate();
        this.getAllStmt = this.db.prepare(
            "SELECT tag, data, etag, published_at, prerelease, expires_at FROM releases WHERE app = ?"
        );
        this.getByTagStmt = this.db.prepare("SELECT data, etag, expires_at FROM releases WHERE app = ? AND tag = ?");
        this.insertStmt = this.db.prepare(
            "INSERT INTO releases (app, tag, data, etag, published_at, prerelease, fetched_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)"
        );
        this.updateStmt = this.db.prepare(
            "UPDATE releases SET data = ?, etag = ?, published_at = ?, prerelease = ?, fetched_at = ?, expires_at = ? WHERE app = ? AND tag = ?"
        );
        this.getPointerStmt = this.db.prepare("SELECT latest_tag, latest_beta_tag FROM app_state WHERE app = ?");
        this.upsertPointerStmt = this.db.prepare(
            "INSERT INTO app_state (app, latest_tag, latest_beta_tag, updated_at) VALUES (?, ?, ?, ?) ON CONFLICT(app) DO UPDATE SET latest_tag = excluded.latest_tag, latest_beta_tag = excluded.latest_beta_tag, updated_at = excluded.updated_at"
        );
        this.newestStableStmt = this.db.prepare(
            "SELECT data, etag, expires_at FROM releases WHERE app = ? AND prerelease = 0 ORDER BY published_at DESC LIMIT 1"
        );
        this.newestAnyStmt = this.db.prepare(
            "SELECT data, etag, expires_at FROM releases WHERE app = ? ORDER BY published_at DESC LIMIT 1"
        );
        this.pageStableStmt = this.db.prepare(
            "SELECT data FROM releases WHERE app = ? AND prerelease = 0 ORDER BY published_at DESC LIMIT ? OFFSET ?"
        );
        this.pageAnyStmt = this.db.prepare(
            "SELECT data FROM releases WHERE app = ? ORDER BY published_at DESC LIMIT ? OFFSET ?"
        );
        this.invalidateAppStmt = this.db.prepare("DELETE FROM releases WHERE app = ?");
        this.invalidateTagStmt = this.db.prepare("DELETE FROM releases WHERE app = ? AND tag = ?");
        this.invalidateAllStmt = this.db.prepare("DELETE FROM releases");
        this.existsStmt = this.db.prepare("SELECT 1 FROM releases WHERE app = ? AND tag = ?");
    }

    getReleases(app: string, options?: GetReleasesOptions): ReleasesCacheEntry | undefined {
        const includePrerelease = options !== undefined && options.includePrerelease === true;
        const rows = this.getAllStmt.all(app) as ReleaseRow[];
        if (rows.length === 0) {
            return undefined;
        }
        const releases: types.Release[] = [];
        let etag: string | undefined;
        let minExpiresAt = Number.MAX_SAFE_INTEGER;
        for (let i = 0; i < rows.length; i = i + 1) {
            const row = rows[i];
            const release = msgpackr.unpack(row.data) as types.Release;
            if (!includePrerelease && release.prerelease) {
                continue;
            }
            releases.push(release);
            if (row.etag !== null && row.etag !== undefined && row.etag.length > 0) {
                etag = row.etag;
            }
            if (row.expires_at < minExpiresAt) {
                minExpiresAt = row.expires_at;
            }
        }
        if (releases.length === 0) {
            return undefined;
        }
        this.logger.debug("Metadata cache read", { app: app, count: releases.length });
        return { releases: releases, etag: etag, expiresAt: minExpiresAt };
    }

    /**
     * Resolves the newest release in O(1) by default.
     *
     * Reads the app_state pointer row and then a single release by primary key. The previous
     * implementation loaded the app's entire history, msgpack-decoded every release, and sorted
     * the lot - on the hot path of every single updater poll.
     *
     * Falls back to a full scan when no pointer exists yet, so a database migrated from an older
     * build still answers correctly on the first request.
     */
    getLatestRelease(app: string, includePrerelease: boolean): ReleaseCacheEntry | undefined {
        const pointers = this.getPointerStmt.get(app) as AppStateRow | undefined;
        if (pointers !== undefined) {
            const tag = includePrerelease ? pointers.latest_beta_tag : pointers.latest_tag;
            if (tag !== null) {
                const entry = this.getReleaseByTag(app, tag);
                if (entry !== undefined) {
                    return entry;
                }
            }
        }
        return this.scanForLatest(app, includePrerelease);
    }

    private scanForLatest(app: string, includePrerelease: boolean): ReleaseCacheEntry | undefined {
        const row = (includePrerelease ? this.newestAnyStmt.get(app) : this.newestStableStmt.get(app)) as
            DataRow | undefined;
        if (row === undefined) {
            return undefined;
        }
        const release = msgpackr.unpack(row.data) as types.Release;
        const etag = row.etag !== null ? row.etag : undefined;
        return { release: release, etag: etag, expiresAt: row.expires_at };
    }

    /**
     * Returns one page of releases, newest first, in O(page size) via the (app, published_at)
     * index. The previous read had no LIMIT, decoded the whole history, and then sliced in memory,
     * so a warm cache ignored the requested page entirely.
     */
    getReleasePage(app: string, limit: number, offset: number, includePrerelease: boolean): types.Release[] {
        const rows = (
            includePrerelease ? this.pageAnyStmt.all(app, limit, offset) : this.pageStableStmt.all(app, limit, offset)
        ) as DataRow[];
        const releases: types.Release[] = [];
        for (let i = 0; i < rows.length; i = i + 1) {
            releases.push(msgpackr.unpack(rows[i].data) as types.Release);
        }
        return releases;
    }

    getReleaseByTag(app: string, tag: string): ReleaseCacheEntry | undefined {
        const row = this.getByTagStmt.get(app, tag) as ReleaseByTagRow | undefined;
        if (row === undefined) {
            return undefined;
        }
        const release = msgpackr.unpack(row.data) as types.Release;
        const etag = row.etag !== null && row.etag !== undefined ? row.etag : undefined;
        this.logger.debug("Metadata cache read by tag", { app: app, tag: tag });
        return { release: release, etag: etag, expiresAt: row.expires_at };
    }

    setReleases(app: string, releases: types.Release[], etag: string | undefined, ttlSeconds: number): void {
        const now = Date.now();
        const expiresAt = now + ttlSeconds * 1000;
        const self = this;
        const transaction = this.db.transaction(function (rels: types.Release[]) {
            for (let i = 0; i < rels.length; i = i + 1) {
                const release = rels[i];
                self.upsertRelease(app, release.tag, release, etag, now, expiresAt);
            }
            self.refreshPointers(app, rels);
        });
        transaction(releases);
        this.logger.debug("Metadata cache wrote releases", { app: app, count: releases.length, etag: etag });
    }

    setRelease(app: string, tag: string, release: types.Release, etag: string | undefined, ttlSeconds: number): void {
        const now = Date.now();
        const expiresAt = now + ttlSeconds * 1000;
        this.upsertRelease(app, tag, release, etag, now, expiresAt);
        this.logger.debug("Metadata cache wrote release", { app: app, tag: tag, etag: etag });
    }

    invalidateApp(app: string): void {
        this.invalidateAppStmt.run(app);
        this.logger.info("Metadata cache invalidated app", { app: app });
    }

    invalidateTag(app: string, tag: string): void {
        this.invalidateTagStmt.run(app, tag);
        this.logger.info("Metadata cache invalidated tag", { app: app, tag: tag });
    }

    invalidateAll(): void {
        this.invalidateAllStmt.run();
        this.logger.info("Metadata cache invalidated all");
    }

    close(): void {
        this.db.close();
    }

    private migrate(): void {
        this.db.exec(`
            CREATE TABLE IF NOT EXISTS releases (
                app TEXT NOT NULL,
                tag TEXT NOT NULL,
                data BLOB NOT NULL,
                etag TEXT,
                published_at INTEGER NOT NULL DEFAULT 0,
                prerelease INTEGER NOT NULL DEFAULT 0,
                fetched_at INTEGER NOT NULL,
                expires_at INTEGER NOT NULL,
                PRIMARY KEY (app, tag)
            );
            CREATE INDEX IF NOT EXISTS idx_releases_app ON releases(app);
            CREATE INDEX IF NOT EXISTS idx_releases_expires ON releases(expires_at);

            -- One small row per app holding the answer to "what is the newest release".
            -- getLatestRelease is on the hot path for every updater poll, and it previously had to
            -- decode the app's entire history and sort it. This turns that into one indexed row
            -- read. Stable and beta are tracked separately so a channel is a pointer swap.
            CREATE TABLE IF NOT EXISTS app_state (
                app TEXT PRIMARY KEY,
                latest_tag TEXT,
                latest_beta_tag TEXT,
                list_etag TEXT,
                updated_at INTEGER NOT NULL DEFAULT 0
            );
        `);
        // Columns first, then the index that depends on them: an existing table predates
        // published_at, and CREATE INDEX would fail against a missing column.
        this.addColumnIfMissing("releases", "published_at", "INTEGER NOT NULL DEFAULT 0");
        this.addColumnIfMissing("releases", "prerelease", "INTEGER NOT NULL DEFAULT 0");
        this.db.exec("CREATE INDEX IF NOT EXISTS idx_releases_latest ON releases(app, published_at DESC)");
        this.db.pragma("journal_mode = WAL");
        this.db.pragma("busy_timeout = 5000");
        this.backfillPublishedAt();
    }

    private addColumnIfMissing(table: string, column: string, definition: string): void {
        const columns = this.db.pragma("table_info(" + table + ")") as { name: string }[];
        for (let i = 0; i < columns.length; i = i + 1) {
            if (columns[i].name === column) {
                return;
            }
        }
        this.db.exec("ALTER TABLE " + table + " ADD COLUMN " + column + " " + definition);
    }

    /**
     * Fills published_at and prerelease for rows written before those columns existed.
     *
     * The values have to come out of the serialised blob, which means decoding once per legacy
     * row at migration time. After this runs, reads never decode a row they do not return.
     */
    private backfillPublishedAt(): void {
        const rows = this.db.prepare("SELECT app, tag, data FROM releases WHERE published_at = 0").all() as {
            app: string;
            tag: string;
            data: Buffer;
        }[];
        if (rows.length === 0) {
            return;
        }
        const update = this.db.prepare(
            "UPDATE releases SET published_at = ?, prerelease = ? WHERE app = ? AND tag = ?"
        );
        const transaction = this.db.transaction(function (items: typeof rows) {
            for (let i = 0; i < items.length; i = i + 1) {
                const item = items[i];
                const release = msgpackr.unpack(item.data) as types.Release;
                const published = Date.parse(release.publishedAt);
                update.run(isNaN(published) ? 0 : published, release.prerelease ? 1 : 0, item.app, item.tag);
            }
        });
        transaction(rows);
        this.logger.info("Metadata cache backfilled release columns", { count: rows.length });
    }

    private upsertRelease(
        app: string,
        tag: string,
        release: types.Release,
        etag: string | undefined,
        fetchedAt: number,
        expiresAt: number
    ): void {
        const data = msgpackr.pack(release);
        const existing = this.existsStmt.get(app, tag) as { readonly "1": number } | undefined;
        const etagValue = etag !== undefined ? etag : null;
        const published = Date.parse(release.publishedAt);
        const publishedAt = isNaN(published) ? 0 : published;
        const prerelease = release.prerelease ? 1 : 0;
        if (existing !== undefined) {
            this.updateStmt.run(data, etagValue, publishedAt, prerelease, fetchedAt, expiresAt, app, tag);
        } else {
            this.insertStmt.run(app, tag, data, etagValue, publishedAt, prerelease, fetchedAt, expiresAt);
        }
    }

    private refreshPointers(app: string, releases: types.Release[]): void {
        let latestTag: string | undefined;
        let latestPublished = -1;
        let latestBetaTag: string | undefined;
        let latestBetaPublished = -1;
        for (let i = 0; i < releases.length; i = i + 1) {
            const release = releases[i];
            const published = Date.parse(release.publishedAt);
            const value = isNaN(published) ? 0 : published;
            if (!release.prerelease && value > latestPublished) {
                latestPublished = value;
                latestTag = release.tag;
            }
            if (value > latestBetaPublished) {
                latestBetaPublished = value;
                latestBetaTag = release.tag;
            }
        }
        if (latestTag === undefined && latestBetaTag === undefined) {
            return;
        }
        // latestBetaTag is only undefined when the set was empty, which returned above; latestTag
        // is legitimately undefined for a prerelease-only set, so only it needs the guard.
        this.upsertPointerStmt.run(
            app,
            latestTag !== undefined ? latestTag : null,
            latestBetaTag as string,
            Date.now()
        );
    }
}
