import * as fs from "node:fs";
import * as path from "node:path";
import { and, count, desc, eq, type SQL } from "drizzle-orm";
import * as msgpackr from "msgpackr";
import * as types from "../../shared/types.js";
import * as logger from "../logging/logger.js";
import { openCacheDatabase, type CacheDatabase, type CacheWriter } from "../db/client.js";
import { appState, releases } from "../db/schema/metadata.js";

export interface MetadataCacheService {
    getReleases(app: string, options?: GetReleasesOptions): ReleasesCacheEntry | undefined;
    getReleaseByTag(app: string, tag: string): ReleaseCacheEntry | undefined;
    getLatestRelease(app: string, includePrerelease: boolean): ReleaseCacheEntry | undefined;
    getReleasePage(app: string, limit: number, offset: number, includePrerelease: boolean): types.Release[];
    countReleases(app: string, includePrerelease: boolean): number;
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

/**
 * One place where msgpackr is called for encoding. The CJS interop types are loose about the
 * return, and naming it keeps that detail out of every call site.
 */
function encode(value: unknown): Buffer {
    return msgpackr.pack(value);
}

export class SqliteMetadataCacheService implements MetadataCacheService {
    private readonly db: CacheDatabase;
    private readonly logger: logger.Logger;

    constructor(cacheDir: string, loggerInstance: logger.Logger) {
        if (!fs.existsSync(cacheDir)) {
            fs.mkdirSync(cacheDir, { recursive: true });
        }
        this.logger = loggerInstance;
        this.db = openCacheDatabase({ filePath: path.join(cacheDir, "metadata.db") });
    }

    getReleases(app: string, options?: GetReleasesOptions): ReleasesCacheEntry | undefined {
        const includePrerelease = options !== undefined && options.includePrerelease === true;
        const rows = this.db
            .select()
            .from(releases)
            .where(
                includePrerelease ? eq(releases.app, app) : and(eq(releases.app, app), eq(releases.prerelease, false))
            )
            .all();
        if (rows.length === 0) {
            return undefined;
        }
        // The prerelease filter is in the WHERE clause, so every row returned is one the caller
        // wants and the loop cannot come back empty.
        const decoded: types.Release[] = [];
        let etag: string | undefined;
        let minExpiresAt = Number.MAX_SAFE_INTEGER;
        for (let i = 0; i < rows.length; i = i + 1) {
            const row = rows[i];
            decoded.push(msgpackr.unpack(row.data) as types.Release);
            if (row.etag !== null && row.etag.length > 0) {
                etag = row.etag;
            }
            if (row.expiresAt < minExpiresAt) {
                minExpiresAt = row.expiresAt;
            }
        }
        this.logger.debug("Metadata cache read", { app: app, count: decoded.length });
        return { releases: decoded, etag: etag, expiresAt: minExpiresAt };
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
        const pointers = this.db.select().from(appState).where(eq(appState.app, app)).get();
        if (pointers !== undefined) {
            const tag = includePrerelease ? pointers.latestBetaTag : pointers.latestTag;
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
        const row = this.db
            .select()
            .from(releases)
            .where(this.scopeFor(app, includePrerelease))
            .orderBy(desc(releases.publishedAt))
            .limit(1)
            .get();
        if (row === undefined) {
            return undefined;
        }
        return {
            release: msgpackr.unpack(row.data) as types.Release,
            etag: row.etag !== null ? row.etag : undefined,
            expiresAt: row.expiresAt
        };
    }

    /**
     * Returns one page of releases, newest first, in O(page size) via the (app, published_at)
     * index. The previous read had no LIMIT, decoded the whole history, and then sliced in memory,
     * so a warm cache ignored the requested page entirely.
     */
    getReleasePage(app: string, limit: number, offset: number, includePrerelease: boolean): types.Release[] {
        const rows = this.db
            .select({ data: releases.data })
            .from(releases)
            .where(this.scopeFor(app, includePrerelease))
            .orderBy(desc(releases.publishedAt))
            // `limit` is the page size, so this returns at most `limit` rows starting at `offset`.
            // Widening the limit to offset+limit would hand back the rows before the page too.
            .limit(limit)
            .offset(offset)
            .all();
        const decoded: types.Release[] = [];
        for (let i = 0; i < rows.length; i = i + 1) {
            decoded.push(msgpackr.unpack(rows[i].data) as types.Release);
        }
        return decoded;
    }

    /**
     * Total matching releases, for the page count the release list needs.
     *
     * An indexed COUNT rather than materialising the app's whole history to measure it, which is
     * what the previous implementation did on every list request.
     */
    countReleases(app: string, includePrerelease: boolean): number {
        // A loop rather than get(), for the same reason as the asset cache's totals: get() is typed
        // as possibly-undefined, and a guard for that is a branch nothing can reach. Starting at
        // zero means the empty case is already correct.
        const rows = this.db
            .select({ total: count() })
            .from(releases)
            .where(this.scopeFor(app, includePrerelease))
            .all();
        let total = 0;
        for (let i = 0; i < rows.length; i = i + 1) {
            total = rows[i].total;
        }
        return total;
    }

    getReleaseByTag(app: string, tag: string): ReleaseCacheEntry | undefined {
        const row = this.db
            .select()
            .from(releases)
            .where(and(eq(releases.app, app), eq(releases.tag, tag)))
            .get();
        if (row === undefined) {
            return undefined;
        }
        this.logger.debug("Metadata cache read by tag", { app: app, tag: tag });
        return {
            release: msgpackr.unpack(row.data) as types.Release,
            etag: row.etag !== null ? row.etag : undefined,
            expiresAt: row.expiresAt
        };
    }

    setReleases(app: string, list: types.Release[], etag: string | undefined, ttlSeconds: number): void {
        const now = Date.now();
        const expiresAt = now + ttlSeconds * 1000;
        const self = this;
        this.db.transaction(function (tx: CacheWriter) {
            for (let i = 0; i < list.length; i = i + 1) {
                const release = list[i];
                self.upsertRelease(tx, app, release.tag, release, etag, now, expiresAt);
            }
            self.refreshPointers(tx, app, list, etag, now);
        });
        this.logger.debug("Metadata cache wrote releases", { app: app, count: list.length, etag: etag });
    }

    setRelease(app: string, tag: string, release: types.Release, etag: string | undefined, ttlSeconds: number): void {
        const now = Date.now();
        const expiresAt = now + ttlSeconds * 1000;
        this.upsertRelease(this.db, app, tag, release, etag, now, expiresAt);
        this.logger.debug("Metadata cache wrote release", { app: app, tag: tag, etag: etag });
    }

    invalidateApp(app: string): void {
        this.db.delete(releases).where(eq(releases.app, app)).run();
        this.logger.info("Metadata cache invalidated app", { app: app });
    }

    invalidateTag(app: string, tag: string): void {
        this.db
            .delete(releases)
            .where(and(eq(releases.app, app), eq(releases.tag, tag)))
            .run();
        this.logger.info("Metadata cache invalidated tag", { app: app, tag: tag });
    }

    invalidateAll(): void {
        this.db.delete(releases).run();
        this.db.delete(appState).run();
        this.logger.info("Metadata cache invalidated all");
    }

    close(): void {
        this.db.$client.close();
    }

    /** Stable only, or stable plus prerelease, depending on the channel. */
    private scopeFor(app: string, includePrerelease: boolean): SQL | undefined {
        if (includePrerelease) {
            return eq(releases.app, app);
        }
        return and(eq(releases.app, app), eq(releases.prerelease, false));
    }

    private upsertRelease(
        tx: CacheWriter,
        app: string,
        tag: string,
        release: types.Release,
        etag: string | undefined,
        fetchedAt: number,
        expiresAt: number
    ): void {
        const published = Date.parse(release.publishedAt);
        tx.insert(releases)
            .values({
                app: app,
                tag: tag,
                data: encode(release),
                etag: etag,
                publishedAt: isNaN(published) ? 0 : published,
                prerelease: release.prerelease,
                fetchedAt: fetchedAt,
                expiresAt: expiresAt
            })
            .onConflictDoUpdate({
                target: [releases.app, releases.tag],
                set: {
                    data: encode(release),
                    etag: etag,
                    publishedAt: isNaN(published) ? 0 : published,
                    prerelease: release.prerelease,
                    fetchedAt: fetchedAt,
                    expiresAt: expiresAt
                }
            })
            .run();
    }

    private refreshPointers(
        tx: CacheWriter,
        app: string,
        list: types.Release[],
        listEtag: string | undefined,
        now: number
    ): void {
        let latestTag: string | undefined;
        let latestPublished = -1;
        let latestBetaTag: string | undefined;
        let latestBetaPublished = -1;
        for (let i = 0; i < list.length; i = i + 1) {
            const release = list[i];
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
        tx.insert(appState)
            .values({
                app: app,
                latestTag: latestTag,
                latestBetaTag: latestBetaTag,
                listEtag: listEtag,
                updatedAt: now
            })
            .onConflictDoUpdate({
                target: appState.app,
                set: {
                    latestTag: latestTag,
                    latestBetaTag: latestBetaTag,
                    listEtag: listEtag,
                    updatedAt: now
                }
            })
            .run();
    }
}
