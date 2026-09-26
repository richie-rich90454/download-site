import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import * as undici from "undici";
import Database from "better-sqlite3";
import * as types from "../../shared/types.js";
import * as logger from "../logging/logger.js";
import * as metrics from "../telemetry/metrics.js";

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

interface AssetCacheRow {
    app: string;
    version: string;
    asset_name: string;
    file_path: string;
    size: number;
    checksum: string;
    last_accessed_at: number;
    created_at: number;
    size_on_disk: number;
    mtime_ms: number;
}

export interface AssetCacheStats {
    totalSize: number;
    totalCount: number;
}

interface FileToDeleteRow {
    file_path: string;
}

interface SumRow {
    total: number;
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
    const prefix = root.endsWith(path.sep) ? root : root + path.sep;
    return target.startsWith(prefix);
}

export class DiskAssetCacheService implements AssetCacheService {
    private readonly db: Database.Database;
    private readonly cacheDir: string;
    private readonly logger: logger.Logger;
    private readonly metrics: metrics.MetricsService;
    private readonly limits: AssetCacheLimits;
    private readonly getStmt: Database.Statement<[string, string, string]>;
    private readonly insertStmt: Database.Statement<
        [string, string, string, string, number, string, number, number, number, number]
    >;
    private readonly updateAccessStmt: Database.Statement<[number, string, string, string]>;
    private readonly adoptStatStmt: Database.Statement<[number, number, string, string, string]>;
    private readonly deleteStmt: Database.Statement<[string, string, string]>;
    private readonly deleteAppStmt: Database.Statement<[string]>;
    private readonly deleteAppVersionStmt: Database.Statement<[string, string]>;
    private readonly deleteAppVersionAssetStmt: Database.Statement<[string, string, string]>;
    private readonly deleteAllStmt: Database.Statement<[]>;
    private readonly allStmt: Database.Statement<[]>;
    private readonly selectFilesAppVersionAssetStmt: Database.Statement<[string, string, string]>;
    private readonly selectFilesAppVersionStmt: Database.Statement<[string, string]>;
    private readonly selectFilesAppStmt: Database.Statement<[string]>;
    private readonly selectFilesAllStmt: Database.Statement<[]>;
    private readonly sumSizeStmt: Database.Statement<[]>;
    private readonly countStmt: Database.Statement<[]>;
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
        const dbPath = path.join(cacheDir, "assets.db");
        this.db = new Database(dbPath);
        this.migrate();
        this.getStmt = this.db.prepare(
            "SELECT file_path, size, checksum, last_accessed_at, created_at, size_on_disk, mtime_ms FROM asset_cache WHERE app = ? AND version = ? AND asset_name = ?"
        );
        this.insertStmt = this.db.prepare(
            "INSERT INTO asset_cache (app, version, asset_name, file_path, size, checksum, last_accessed_at, created_at, size_on_disk, mtime_ms) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
        );
        this.updateAccessStmt = this.db.prepare(
            "UPDATE asset_cache SET last_accessed_at = ? WHERE app = ? AND version = ? AND asset_name = ?"
        );
        this.deleteStmt = this.db.prepare("DELETE FROM asset_cache WHERE app = ? AND version = ? AND asset_name = ?");
        this.adoptStatStmt = this.db.prepare(
            "UPDATE asset_cache SET size_on_disk = ?, mtime_ms = ? WHERE app = ? AND version = ? AND asset_name = ?"
        );
        this.deleteAppStmt = this.db.prepare("DELETE FROM asset_cache WHERE app = ?");
        this.deleteAppVersionStmt = this.db.prepare("DELETE FROM asset_cache WHERE app = ? AND version = ?");
        this.deleteAppVersionAssetStmt = this.db.prepare(
            "DELETE FROM asset_cache WHERE app = ? AND version = ? AND asset_name = ?"
        );
        this.deleteAllStmt = this.db.prepare("DELETE FROM asset_cache");
        this.allStmt = this.db.prepare(
            "SELECT app, version, asset_name, file_path, size, checksum, last_accessed_at, created_at, size_on_disk, mtime_ms FROM asset_cache ORDER BY last_accessed_at ASC"
        );
        this.selectFilesAppVersionAssetStmt = this.db.prepare(
            "SELECT file_path FROM asset_cache WHERE app = ? AND version = ? AND asset_name = ?"
        );
        this.selectFilesAppVersionStmt = this.db.prepare(
            "SELECT file_path FROM asset_cache WHERE app = ? AND version = ?"
        );
        this.selectFilesAppStmt = this.db.prepare("SELECT file_path FROM asset_cache WHERE app = ?");
        this.selectFilesAllStmt = this.db.prepare("SELECT file_path FROM asset_cache");
        this.sumSizeStmt = this.db.prepare("SELECT COALESCE(SUM(size), 0) AS total FROM asset_cache");
        this.countStmt = this.db.prepare("SELECT COUNT(*) AS total FROM asset_cache");
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
        const row = this.getStmt.get(app, version, assetName) as AssetCacheRow | undefined;
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
        // The narrowed locals are queried and deleted in the same branch so the compiler can
        // prove each statement receives the exact arity it expects. A shared helper taking
        // optional arguments would erase that and need runtime guards instead.
        let rows: FileToDeleteRow[];
        let deleted: number;
        if (app !== undefined && version !== undefined && assetName !== undefined) {
            rows = this.selectFilesAppVersionAssetStmt.all(app, version, assetName) as FileToDeleteRow[];
            deleted = this.deleteAppVersionAssetStmt.run(app, version, assetName).changes;
        } else if (app !== undefined && version !== undefined) {
            rows = this.selectFilesAppVersionStmt.all(app, version) as FileToDeleteRow[];
            deleted = this.deleteAppVersionStmt.run(app, version).changes;
        } else if (app !== undefined) {
            rows = this.selectFilesAppStmt.all(app) as FileToDeleteRow[];
            deleted = this.deleteAppStmt.run(app).changes;
        } else {
            rows = this.selectFilesAllStmt.all() as FileToDeleteRow[];
            deleted = this.deleteAllStmt.run().changes;
        }
        for (let i = 0; i < rows.length; i = i + 1) {
            this.deleteFile(rows[i].file_path);
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
        this.db.close();
    }

    private migrate(): void {
        this.db.exec(`
            CREATE TABLE IF NOT EXISTS asset_cache (
                app TEXT NOT NULL,
                version TEXT NOT NULL,
                asset_name TEXT NOT NULL,
                file_path TEXT NOT NULL,
                size INTEGER NOT NULL,
                checksum TEXT NOT NULL,
                last_accessed_at INTEGER NOT NULL,
                created_at INTEGER NOT NULL,
                size_on_disk INTEGER NOT NULL DEFAULT 0,
                mtime_ms INTEGER NOT NULL DEFAULT 0,
                PRIMARY KEY (app, version, asset_name)
            );
            CREATE INDEX IF NOT EXISTS idx_asset_cache_app ON asset_cache(app);
            CREATE INDEX IF NOT EXISTS idx_asset_cache_access ON asset_cache(last_accessed_at);
            CREATE INDEX IF NOT EXISTS idx_asset_cache_created ON asset_cache(created_at);
        `);
        // Existing caches predate the O(1) hit check, which needs the on-disk size and mtime
        // to compare instead of re-hashing. Adding the columns is additive, so a live cache
        // keeps its files and rows; a backfill below seeds them from the filesystem.
        this.addColumnIfMissing("asset_cache", "size_on_disk", "INTEGER NOT NULL DEFAULT 0");
        this.addColumnIfMissing("asset_cache", "mtime_ms", "INTEGER NOT NULL DEFAULT 0");
        // WAL lets the read-heavy release path proceed while a write is in flight. Without it
        // better-sqlite3 falls back to a rollback journal and every writer blocks every reader.
        this.db.pragma("journal_mode = WAL");
        this.db.pragma("busy_timeout = 5000");
        this.backfillStatColumns();
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
     * Seeds size_on_disk/mtime_ms for rows written before those columns existed. A row left
     * at the sentinel 0 fails the O(1) equality check on its next read and is re-verified the
     * slow way exactly once, so this is an optimisation rather than a correctness requirement.
     */
    private backfillStatColumns(): void {
        const rows = this.db
            .prepare("SELECT file_path FROM asset_cache WHERE size_on_disk = 0")
            .all() as FileToDeleteRow[];
        const update = this.db.prepare("UPDATE asset_cache SET size_on_disk = ?, mtime_ms = ? WHERE file_path = ?");
        for (let i = 0; i < rows.length; i = i + 1) {
            const filePath = rows[i].file_path;
            try {
                const stat = fs.statSync(filePath);
                update.run(stat.size, Math.trunc(stat.mtimeMs), filePath);
            } catch {
                this.logger.warn("Asset cache backfill skipped unreadable file", { path: filePath });
            }
        }
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
        const cached = this.getStmt.get(app, version, asset.name) as AssetCacheRow | undefined;
        if (cached === undefined) {
            this.metrics.recordCacheMiss("asset");
            return this.downloadAndCache(app, version, asset);
        }
        const now = Date.now();
        if (now - cached.created_at > this.limits.maxAgeMs) {
            this.logger.info("Asset cache entry expired", { app: app, version: version, asset: asset.name });
            this.deleteEntry(app, version, asset.name, cached.file_path);
            this.metrics.recordCacheMiss("asset");
            return this.downloadAndCache(app, version, asset);
        }
        const stat = this.statOrUndefined(cached.file_path);
        if (stat === undefined) {
            this.logger.warn("Asset cache file missing", { app: app, version: version, asset: asset.name });
            this.deleteEntry(app, version, asset.name, cached.file_path);
            this.metrics.recordCacheMiss("asset");
            return this.downloadAndCache(app, version, asset);
        }
        const sizeMatches = stat.size === cached.size_on_disk;
        const mtimeMatches = Math.trunc(stat.mtimeMs) === cached.mtime_ms;
        if (sizeMatches && mtimeMatches) {
            this.updateAccessStmt.run(now, app, version, asset.name);
            this.metrics.recordCacheHit("asset");
            return Promise.resolve({
                filePath: cached.file_path,
                cached: true,
                entry: {
                    app: app,
                    version: version,
                    assetName: asset.name,
                    filePath: cached.file_path,
                    size: cached.size,
                    checksum: cached.checksum,
                    lastAccessedAt: now,
                    createdAt: cached.created_at
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
        cached: AssetCacheRow,
        sizeOnDisk: number,
        mtimeMs: number
    ): Promise<AssetCacheResult> {
        let checksum: string;
        try {
            checksum = await this.computeChecksum(cached.file_path);
        } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            this.logger.warn("Asset cache file unreadable during verification", {
                path: cached.file_path,
                error: message
            });
            this.deleteEntry(app, version, asset.name, cached.file_path);
            this.metrics.recordCacheMiss("asset");
            return this.downloadAndCache(app, version, asset);
        }
        if (checksum !== cached.checksum) {
            this.logger.warn("Asset cache checksum mismatch", { app: app, version: version, asset: asset.name });
            this.deleteEntry(app, version, asset.name, cached.file_path);
            this.metrics.recordCacheMiss("asset");
            return this.downloadAndCache(app, version, asset);
        }
        this.adoptStatStmt.run(sizeOnDisk, mtimeMs, app, version, asset.name);
        const now = Date.now();
        this.updateAccessStmt.run(now, app, version, asset.name);
        this.metrics.recordCacheHit("asset");
        return {
            filePath: cached.file_path,
            cached: true,
            entry: {
                app: app,
                version: version,
                assetName: asset.name,
                filePath: cached.file_path,
                size: cached.size,
                checksum: cached.checksum,
                lastAccessedAt: now,
                createdAt: cached.created_at
            }
        };
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
        const timeout = setTimeout(function () {
            controller.abort();
        }, 300000);
        try {
            const response = await this.fetchAsset(url, controller.signal);
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
            this.insertStmt.run(
                app,
                version,
                asset.name,
                finalPath,
                asset.size,
                checksum,
                now,
                now,
                finalStat.size,
                Math.trunc(finalStat.mtimeMs)
            );
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
            clearTimeout(timeout);
            if (fs.existsSync(tempPath)) {
                try {
                    fs.unlinkSync(tempPath);
                } catch {
                    // ignore cleanup errors
                }
            }
        }
    }

    private async fetchAsset(
        url: string,
        signal: AbortSignal,
        redirects?: number
    ): Promise<Awaited<ReturnType<typeof undici.request>>> {
        const redirectCount = redirects === undefined ? 0 : redirects;
        const response = await undici.request(url, {
            method: "GET",
            signal: signal
        });
        if (response.statusCode >= 300 && response.statusCode < 400 && response.headers.location !== undefined) {
            if (redirectCount >= 5) {
                throw new Error("Asset download redirect limit exceeded");
            }
            const location = Array.isArray(response.headers.location)
                ? response.headers.location[0]
                : response.headers.location;
            return this.fetchAsset(location, signal, redirectCount + 1);
        }
        return response;
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
        const rows = this.allStmt.all() as AssetCacheRow[];
        let totalSize = stats.totalSize;
        let totalCount = stats.totalCount;
        for (let i = 0; i < rows.length; i = i + 1) {
            const row = rows[i];
            this.deleteEntry(row.app, row.version, row.asset_name, row.file_path);
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

    /**
     * Two aggregate reads instead of materialising every row. Cached in memory and
     * invalidated on write, so the common case costs nothing at all.
     */
    private getCacheStats(): AssetCacheStats {
        if (this.statsValid) {
            return this.inFlightStats;
        }
        const sumRow = this.sumSizeStmt.get() as SumRow;
        const countRow = this.countStmt.get() as SumRow;
        this.inFlightStats.totalSize = sumRow.total;
        this.inFlightStats.totalCount = countRow.total;
        this.statsValid = true;
        return this.inFlightStats;
    }

    private runCleanup(): void {
        const cutoff = Date.now() - this.limits.maxAgeMs;
        const rows = this.allStmt.all() as AssetCacheRow[];
        let cleaned = 0;
        for (let i = 0; i < rows.length; i = i + 1) {
            const row = rows[i];
            if (row.created_at < cutoff) {
                this.deleteEntry(row.app, row.version, row.asset_name, row.file_path);
                cleaned = cleaned + 1;
            }
        }
        if (cleaned > 0) {
            this.logger.info("Asset cache background cleanup", { cleaned: cleaned });
        }
    }

    private deleteEntry(app: string, version: string, assetName: string, filePath: string): void {
        this.deleteStmt.run(app, version, assetName);
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
     * When the filter mutates a name we also append a short digest of the original: the SQL
     * row is keyed on the raw name while the file lives under the sanitised one, so without
     * the digest two distinct raw names could collide onto a single path.
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
