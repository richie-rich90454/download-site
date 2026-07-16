import * as fs from "node:fs";
import * as path from "node:path";
import Database from "better-sqlite3";
import * as msgpackr from "msgpackr";
import * as types from "../../shared/types.js";
import * as logger from "../logging/logger.js";

export interface MetadataCacheService {
    getReleases(app: string, options?: GetReleasesOptions): ReleasesCacheEntry | undefined;
    getReleaseByTag(app: string, tag: string): ReleaseCacheEntry | undefined;
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

export class SqliteMetadataCacheService implements MetadataCacheService {
    private readonly db: Database.Database;
    private readonly logger: logger.Logger;
    private readonly getAllStmt: Database.Statement<[string]>;
    private readonly getByTagStmt: Database.Statement<[string, string]>;
    private readonly insertStmt: Database.Statement<[string, string, Buffer, string | null, number, number]>;
    private readonly updateStmt: Database.Statement<[Buffer, string | null, number, number, string, string]>;
    private readonly invalidateAppStmt: Database.Statement<[string]>;
    private readonly invalidateTagStmt: Database.Statement<[string, string]>;
    private readonly invalidateAllStmt: Database.Statement<[]>;
    private readonly existsStmt: Database.Statement<[string, string]>;

    constructor(cacheDir: string, loggerInstance: logger.Logger) {
        if (!fs.existsSync(cacheDir)) {
            fs.mkdirSync(cacheDir, { recursive: true });
        }
        const dbPath = path.join(cacheDir, "metadata.db");
        this.db = new Database(dbPath);
        this.logger = loggerInstance;
        this.migrate();
        this.getAllStmt = this.db.prepare("SELECT tag, data, etag, expires_at FROM releases WHERE app = ?");
        this.getByTagStmt = this.db.prepare("SELECT data, etag, expires_at FROM releases WHERE app = ? AND tag = ?");
        this.insertStmt = this.db.prepare(
            "INSERT INTO releases (app, tag, data, etag, fetched_at, expires_at) VALUES (?, ?, ?, ?, ?, ?)"
        );
        this.updateStmt = this.db.prepare(
            "UPDATE releases SET data = ?, etag = ?, fetched_at = ?, expires_at = ? WHERE app = ? AND tag = ?"
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
                fetched_at INTEGER NOT NULL,
                expires_at INTEGER NOT NULL,
                PRIMARY KEY (app, tag)
            );
            CREATE INDEX IF NOT EXISTS idx_releases_app ON releases(app);
            CREATE INDEX IF NOT EXISTS idx_releases_expires ON releases(expires_at);
        `);
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
        if (existing !== undefined) {
            this.updateStmt.run(data, etagValue, fetchedAt, expiresAt, app, tag);
        } else {
            this.insertStmt.run(app, tag, data, etagValue, fetchedAt, expiresAt);
        }
    }
}
