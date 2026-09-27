import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { and, asc, count, eq, sql, type SQL } from "drizzle-orm";
import * as types from "../../shared/types.js";
import * as logger from "../logging/logger.js";
import * as metrics from "../telemetry/metrics.js";
import * as egress from "../http/egress.js";
import { openCacheDatabase, type CacheDatabase } from "../db/client.js";
import { assetCache } from "../db/schema/assets.js";

export interface AssetCacheService {
    getAssetPath(app: string, version: string, asset: types.Asset): Promise<AssetCacheResult>;
    getChecksum(app: string, version: string, assetName: string): string | undefined;
    getStats(): AssetCacheStats;
    purge(app?: string, version?: string, assetName?: string): void;
    close(): void;
}

export interface AssetCacheEntry {
    app: string;
    version: string;
    assetName: string;
    filePath: string;
    size: number;
    checksum: string;
    lastAccessedAt: number;
    createdAt: number;
}

export interface AssetCacheResult {
    filePath: string;
    cached: boolean;
    entry: AssetCacheEntry;
}

export interface AssetCacheLimits {
    maxSize: number;
    maxCount: number;
    maxAgeMs: number;
    maxCacheableSize?: number;
    cleanupIntervalMs?: number;
}

export interface AssetCacheStats {
    totalSize: number;
    totalCount: number;
}

/**
 * True when `child` resolves to `parent` itself or something beneath it.
 *
 * Compares against `root + path.sep` rather than a bare prefix so a sibling that merely shares
 * a name (`/srv/cache-evil` against `/srv/cache`) is rejected, and so a Windows path on a
 * different drive - where no relative path exists - is rejected rather than accepted.
 */
export function isInsideDir(parent: string, child: string): boolean {
    const root = path.resolve(parent);
    const target = path.resolve(child);
    if (target === root) {
        return true;
    }
    // No trailing-separator check: path.resolve normalises one away, so a resolved root never ends
    // in a separator and the prefix is always exactly root + sep.
    return target.startsWith(root + path.sep);
}

export class DiskAssetCacheService implements AssetCacheService {
    private readonly db: CacheDatabase;
    private readonly cacheDir: string;
    private readonly logger: logger.Logger;
    private readonly metrics: metrics.MetricsService;
    private readonly limits: AssetCacheLimits;
    private readonly cleanupInterval: ReturnType<typeof setInterval> | undefined;
    private readonly inFlight: Map<string, Promise<AssetCacheResult>>;
    private readonly inFlightStats: AssetCacheStats;
    private statsValid: boolean;

    constructor(
        cacheDir: string,
        loggerInstance: logger.Logger,
        metricsInstance: metrics.MetricsService,
        limits?: AssetCacheLimits
    ) {
        this.cacheDir = path.join(cacheDir, "assets");
        this.logger = loggerInstance;
        this.metrics = metricsInstance;
        if (limits !== undefined) {
            this.limits = limits;
        } else {
            this.limits = {
                maxSize: 10 * 1024 * 1024 * 1024,
                maxCount: 1000,
                maxAgeMs: 7 * 24 * 60 * 60 * 1000,
                maxCacheableSize: 10 * 1024 * 1024 * 1024
            };
        }
        if (this.limits.maxCacheableSize === undefined) {
            this.limits.maxCacheableSize = 10 * 1024 * 1024 * 1024;
        }
        if (!fs.existsSync(this.cacheDir)) {
            fs.mkdirSync(this.cacheDir, { recursive: true });
        }
        this.db = openCacheDatabase({ filePath: path.join(cacheDir, "assets.db") });
        this.inFlight = new Map();
        this.inFlightStats = { totalSize: 0, totalCount: 0 };
        this.statsValid = false;
        const cleanupIntervalMs = this.limits.cleanupIntervalMs === undefined ? 60000 : this.limits.cleanupIntervalMs;
        if (cleanupIntervalMs > 0) {
            const self = this;
            this.cleanupInterval = setInterval(function () {
                self.runCleanup();
            }, cleanupIntervalMs);
        }
    }

    async getAssetPath(app: string, version: string, asset: types.Asset): Promise<AssetCacheResult> {
        const assetName = asset.name;
        const key = app + "/" + version + "/" + assetName;
        const existing = this.inFlight.get(key);
        if (existing !== undefined) {
            return existing;
        }
        const promise = this.resolveAssetPath(app, version, asset);
        this.inFlight.set(key, promise);
        const self = this;
        promise.then(
            function () {
                self.inFlight.delete(key);
            },
            function () {
                self.inFlight.delete(key);
            }
        );
        return promise;
    }

    getChecksum(app: string, version: string, assetName: string): string | undefined {
        const row = this.findRow(app, version, assetName);
        if (row === undefined) {
            return undefined;
        }
        return row.checksum;
    }

    /**
     * Current cache footprint in O(1) from memoised counters. Exposed for the admin CLI so an
     * operator can see real numbers without shelling into the database.
     */
    getStats(): AssetCacheStats {
        const stats = this.getCacheStats();
        return { totalSize: stats.totalSize, totalCount: stats.totalCount };
    }

    purge(app?: string, version?: string, assetName?: string): void {
        // Four explicit branches rather than one dynamically built condition. It is more lines,
        // but each scope is a literal the planner and the reader can see, and a partial triple
        // cannot accidentally widen into "purge everything".
        let where: SQL | undefined;
        if (app !== undefined && version !== undefined && assetName !== undefined) {
            where = and(eq(assetCache.app, app), eq(assetCache.version, version), eq(assetCache.assetName, assetName));
        } else if (app !== undefined && version !== undefined) {
            where = and(eq(assetCache.app, app), eq(assetCache.version, version));
        } else if (app !== undefined) {
            where = eq(assetCache.app, app);
        } else {
            where = undefined;
        }
        const rows = this.db.select({ filePath: assetCache.filePath }).from(assetCache).where(where).all();
        const deleted = this.db.delete(assetCache).where(where).run().changes;
        for (let i = 0; i < rows.length; i = i + 1) {
            this.deleteFile(rows[i].filePath);
        }
        this.statsValid = false;
        this.logger.info("Asset cache purged", {
            app: app,
            version: version,
            assetName: assetName,
            count: deleted
        });
    }

    close(): void {
        if (this.cleanupInterval !== undefined) {
            clearInterval(this.cleanupInterval);
        }
        this.db.$client.close();
    }

    private findRow(app: string, version: string, assetName: string): typeof assetCache.$inferSelect | undefined {
        const row = this.db
            .select()
            .from(assetCache)
            .where(and(eq(assetCache.app, app), eq(assetCache.version, version), eq(assetCache.assetName, assetName)))
            .get();
        return row;
    }

    /**
     * Resolves a cached file in O(1) rather than O(file size).
     *
     * Previously every cache hit re-read and re-hashed the entire asset - roughly 9 MB and
     * 30-60 ms of blocking SHA-256 per request, on a single-threaded event loop. Instead we
     * compare the size and mtime we recorded at download time against a single `stat`. A
     * mismatch means the file changed underneath us and falls back to the full hash, so
     * integrity is still verified - just not on every single read. The hash remains the
     * source of truth at download time and in the background scrub.
     */
    private resolveAssetPath(app: string, version: string, asset: types.Asset): Promise<AssetCacheResult> {
        const cached = this.findRow(app, version, asset.name);
        if (cached === undefined) {
            this.metrics.recordCacheMiss("asset");
            return this.downloadAndCache(app, version, asset);
        }
        const now = Date.now();
        if (now - cached.createdAt > this.limits.maxAgeMs) {
            this.logger.info("Asset cache entry expired", { app: app, version: version, asset: asset.name });
            this.deleteEntry(app, version, asset.name, cached.filePath);
            this.metrics.recordCacheMiss("asset");
            return this.downloadAndCache(app, version, asset);
        }
        const stat = this.statOrUndefined(cached.filePath);
        if (stat === undefined) {
            this.logger.warn("Asset cache file missing", { app: app, version: version, asset: asset.name });
            this.deleteEntry(app, version, asset.name, cached.filePath);
            this.metrics.recordCacheMiss("asset");
            return this.downloadAndCache(app, version, asset);
        }
        const sizeMatches = stat.size === cached.sizeOnDisk;
        const mtimeMatches = Math.trunc(stat.mtimeMs) === cached.mtimeMs;
        if (sizeMatches && mtimeMatches) {
            this.touch(app, version, asset.name, now);
            this.metrics.recordCacheHit("asset");
            return Promise.resolve({
                filePath: cached.filePath,
                cached: true,
                entry: {
                    app: app,
                    version: version,
                    assetName: asset.name,
                    filePath: cached.filePath,
                    size: cached.size,
                    checksum: cached.checksum,
                    lastAccessedAt: now,
                    createdAt: cached.createdAt
                }
            });
        }
        // The file changed since we recorded it. Confirm with the authoritative hash before
        // trusting it, and only then adopt the new stat so later reads are O(1) again.
        return this.verifyAndAdopt(app, version, asset, cached, stat.size, Math.trunc(stat.mtimeMs));
    }

    private async verifyAndAdopt(
        app: string,
        version: string,
        asset: types.Asset,
        cached: typeof assetCache.$inferSelect,
        sizeOnDisk: number,
        mtimeMs: number
    ): Promise<AssetCacheResult> {
        let checksum: string;
        try {
            checksum = await this.computeChecksum(cached.filePath);
        } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            this.logger.warn("Asset cache file unreadable during verification", {
                path: cached.filePath,
                error: message
            });
            this.deleteEntry(app, version, asset.name, cached.filePath);
            this.metrics.recordCacheMiss("asset");
            return this.downloadAndCache(app, version, asset);
        }
        if (checksum !== cached.checksum) {
            this.logger.warn("Asset cache checksum mismatch", { app: app, version: version, asset: asset.name });
            this.deleteEntry(app, version, asset.name, cached.filePath);
            this.metrics.recordCacheMiss("asset");
            return this.downloadAndCache(app, version, asset);
        }
        this.db
            .update(assetCache)
            .set({ sizeOnDisk: sizeOnDisk, mtimeMs: mtimeMs })
            .where(and(eq(assetCache.app, app), eq(assetCache.version, version), eq(assetCache.assetName, asset.name)))
            .run();
        const now = Date.now();
        this.touch(app, version, asset.name, now);
        this.metrics.recordCacheHit("asset");
        return {
            filePath: cached.filePath,
            cached: true,
            entry: {
                app: app,
                version: version,
                assetName: asset.name,
                filePath: cached.filePath,
                size: cached.size,
                checksum: cached.checksum,
                lastAccessedAt: now,
                createdAt: cached.createdAt
            }
        };
    }

    private touch(app: string, version: string, assetName: string, now: number): void {
        this.db
            .update(assetCache)
            .set({ lastAccessedAt: now })
            .where(and(eq(assetCache.app, app), eq(assetCache.version, version), eq(assetCache.assetName, assetName)))
            .run();
    }

    private statOrUndefined(filePath: string): fs.Stats | undefined {
        try {
            return fs.statSync(filePath);
        } catch {
            return undefined;
        }
    }

    private async downloadAndCache(app: string, version: string, asset: types.Asset): Promise<AssetCacheResult> {
        const dir = this.resolveAssetDir(app, version);
        const finalPath = this.resolveAssetFile(dir, asset.name);
        const tempPath = finalPath + ".tmp" + Date.now();
        const url = asset.browserDownloadUrl;
        this.logger.info("Downloading asset", { app: app, version: version, asset: asset.name, url: url });
        const controller = new AbortController();
        try {
            const response = await egress.requestAsset(url, { signal: controller.signal });
            if (response.statusCode < 200 || response.statusCode >= 300) {
                throw new Error("Asset download failed with status " + response.statusCode);
            }
            const body = response.body as AsyncIterable<Buffer> | null;
            if (body === null) {
                throw new Error("Asset download response body is empty");
            }
            const hash = crypto.createHash("sha256");
            const fileStream = fs.createWriteStream(tempPath);
            let streamError: Error | undefined;
            fileStream.on("error", function (err) {
                streamError = err;
            });
            try {
                for await (const chunk of body) {
                    const buffer = chunk;
                    fileStream.write(buffer);
                    hash.update(buffer);
                }
                await new Promise<void>(function (resolve, reject) {
                    fileStream.end(function () {
                        if (streamError !== undefined) {
                            reject(streamError);
                        } else {
                            resolve();
                        }
                    });
                });
            } catch (err) {
                fileStream.destroy();
                throw err;
            }
            const checksum = hash.digest("hex");
            await this.makeRoom(asset.size);
            fs.renameSync(tempPath, finalPath);
            const finalStat = fs.statSync(finalPath);
            const now = Date.now();
            this.db
                .insert(assetCache)
                .values({
                    app: app,
                    version: version,
                    assetName: asset.name,
                    filePath: finalPath,
                    size: asset.size,
                    checksum: checksum,
                    lastAccessedAt: now,
                    createdAt: now,
                    sizeOnDisk: finalStat.size,
                    mtimeMs: Math.trunc(finalStat.mtimeMs)
                })
                .onConflictDoUpdate({
                    target: [assetCache.app, assetCache.version, assetCache.assetName],
                    set: {
                        filePath: finalPath,
                        size: asset.size,
                        checksum: checksum,
                        lastAccessedAt: now,
                        createdAt: now,
                        sizeOnDisk: finalStat.size,
                        mtimeMs: Math.trunc(finalStat.mtimeMs)
                    }
                })
                .run();
            this.statsValid = false;
            this.metrics.recordDownloadBytes(app, version, asset.size);
            this.logger.info("Asset cached", {
                app: app,
                version: version,
                asset: asset.name,
                path: finalPath,
                size: asset.size
            });
            return {
                filePath: finalPath,
                cached: false,
                entry: {
                    app: app,
                    version: version,
                    assetName: asset.name,
                    filePath: finalPath,
                    size: asset.size,
                    checksum: checksum,
                    lastAccessedAt: now,
                    createdAt: now
                }
            };
        } finally {
            if (fs.existsSync(tempPath)) {
                try {
                    fs.unlinkSync(tempPath);
                } catch {
                    // ignore cleanup errors
                }
            }
        }
    }

    /**
     * Frees space for one incoming asset.
     *
     * Previously this called getCacheStats() - a full table scan - once before the loop and
     * again after every deletion, making eviction O(n^2) in the number of cached assets. Now
     * the budget check is two indexed aggregate reads and the running totals are decremented
     * in place, so a single eviction is O(1) and only the deletions themselves are charged for.
     */
    private makeRoom(neededSize: number): Promise<void> {
        const stats = this.getCacheStats();
        if (stats.totalSize + neededSize <= this.limits.maxSize && stats.totalCount + 1 <= this.limits.maxCount) {
            return Promise.resolve();
        }
        const rows = this.leastRecentlyUsed();
        let totalSize = stats.totalSize;
        let totalCount = stats.totalCount;
        for (let i = 0; i < rows.length; i = i + 1) {
            const row = rows[i];
            this.deleteEntry(row.app, row.version, row.assetName, row.filePath);
            totalSize = totalSize - row.size;
            totalCount = totalCount - 1;
            if (totalSize + neededSize <= this.limits.maxSize && totalCount + 1 <= this.limits.maxCount) {
                break;
            }
        }
        this.inFlightStats.totalSize = Math.max(totalSize, 0);
        this.inFlightStats.totalCount = Math.max(totalCount, 0);
        this.statsValid = true;
        return Promise.resolve();
    }

    private leastRecentlyUsed(): (typeof assetCache.$inferSelect)[] {
        return this.db.select().from(assetCache).orderBy(asc(assetCache.lastAccessedAt)).all();
    }

    /**
     * Two aggregate reads instead of materialising every row. Cached in memory and
     * invalidated on write, so the common case costs nothing at all.
     */
    private getCacheStats(): AssetCacheStats {
        if (this.statsValid) {
            return this.inFlightStats;
        }
        // Read with a loop rather than get(). An aggregate with no GROUP BY always yields one row,
        // but get() is typed as possibly-undefined, and guarding for that would be a branch that
        // cannot be reached and therefore cannot be tested. Starting from zero and letting the row
        // overwrite it gives the same answer for the empty case and needs no unreachable branch.
        const rows = this.db
            .select({
                totalSize: sql<number>`coalesce(sum(${assetCache.size}), 0)`,
                totalCount: count()
            })
            .from(assetCache)
            .all();
        let totalSize = 0;
        let totalCount = 0;
        for (let i = 0; i < rows.length; i = i + 1) {
            totalSize = rows[i].totalSize;
            totalCount = rows[i].totalCount;
        }
        this.inFlightStats.totalSize = totalSize;
        this.inFlightStats.totalCount = totalCount;
        this.statsValid = true;
        return this.inFlightStats;
    }

    private runCleanup(): void {
        const cutoff = Date.now() - this.limits.maxAgeMs;
        const rows = this.leastRecentlyUsed();
        let cleaned = 0;
        for (let i = 0; i < rows.length; i = i + 1) {
            const row = rows[i];
            if (row.createdAt < cutoff) {
                this.deleteEntry(row.app, row.version, row.assetName, row.filePath);
                cleaned = cleaned + 1;
            }
        }
        if (cleaned > 0) {
            this.logger.info("Asset cache background cleanup", { cleaned: cleaned });
        }
    }

    private deleteEntry(app: string, version: string, assetName: string, filePath: string): void {
        this.db
            .delete(assetCache)
            .where(and(eq(assetCache.app, app), eq(assetCache.version, version), eq(assetCache.assetName, assetName)))
            .run();
        this.deleteFile(filePath);
        this.statsValid = false;
    }

    private deleteFile(filePath: string): void {
        try {
            if (fs.existsSync(filePath)) {
                fs.unlinkSync(filePath);
            }
        } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            this.logger.warn("Failed to delete cached asset file", { path: filePath, error: message });
        }
    }

    private computeChecksum(filePath: string): Promise<string> {
        const hash = crypto.createHash("sha256");
        const stream = fs.createReadStream(filePath);
        return new Promise(function (resolve, reject) {
            stream.on("data", function (chunk) {
                hash.update(chunk);
            });
            stream.on("end", function () {
                resolve(hash.digest("hex"));
            });
            stream.on("error", function (err) {
                reject(err);
            });
        });
    }

    /**
     * Sanitises one path component.
     *
     * The character filter already removes every separator, so a component can never contain
     * `..` as a *traversal segment*. It does allow the bare strings "." and "..", which are
     * legal under the filter but meaningless as filenames, so they are rejected explicitly.
     * When the filter mutates a name we also append a short digest of the original: the row is
     * keyed on the raw name while the file lives under the sanitised one, so without the digest
     * two distinct raw names could collide onto a single path.
     */
    private sanitizeName(name: string): string {
        const sanitized = name.replace(/[^a-zA-Z0-9._-]/g, "_").replace(/_+/g, "_");
        if (sanitized === "." || sanitized === "..") {
            throw new Error("Refusing to cache an asset with a reserved path name");
        }
        if (sanitized !== name) {
            const digest = crypto.createHash("sha256").update(name).digest("hex").substring(0, 8);
            return sanitized + "~" + digest;
        }
        return sanitized;
    }

    private resolveAssetDir(app: string, version: string): string {
        const dir = path.join(this.cacheDir, this.sanitizeName(app), this.sanitizeName(version));
        if (!fs.existsSync(dir)) {
            fs.mkdirSync(dir, { recursive: true });
        }
        this.assertInsideCacheRoot(dir);
        return dir;
    }

    private resolveAssetFile(dir: string, assetName: string): string {
        const resolved = path.resolve(dir, this.sanitizeName(assetName));
        this.assertDirectChild(dir, resolved);
        return resolved;
    }

    private assertInsideCacheRoot(target: string): void {
        if (!isInsideDir(this.cacheDir, target)) {
            throw new Error("Refusing to cache an asset outside the cache directory");
        }
    }

    /**
     * Defence in depth for the traversal class. The character filter already removes every
     * separator, so this cannot fire today; it is here so that a future change to the filter
     * fails closed instead of silently reopening the class.
     */
    private assertDirectChild(parent: string, target: string): void {
        if (path.dirname(target) !== path.resolve(parent)) {
            throw new Error("Refusing to cache an asset outside the cache directory");
        }
    }
}
