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
}

interface FileToDeleteRow {
    file_path: string;
}

export class DiskAssetCacheService implements AssetCacheService {
    private readonly db: Database.Database;
    private readonly cacheDir: string;
    private readonly logger: logger.Logger;
    private readonly metrics: metrics.MetricsService;
    private readonly limits: AssetCacheLimits;
    private readonly getStmt: Database.Statement<[string, string, string]>;
    private readonly insertStmt: Database.Statement<[string, string, string, string, number, string, number, number]>;
    private readonly updateAccessStmt: Database.Statement<[number, string, string, string]>;
    private readonly deleteStmt: Database.Statement<[string, string, string]>;
    private readonly deleteAppStmt: Database.Statement<[string]>;
    private readonly deleteAppVersionStmt: Database.Statement<[string, string]>;
    private readonly deleteAppVersionAssetStmt: Database.Statement<[string, string, string]>;
    private readonly deleteAllStmt: Database.Statement<[]>;
    private readonly allStmt: Database.Statement<[]>;
    private readonly cleanupInterval: ReturnType<typeof setInterval> | undefined;
    private readonly inFlight: Map<string, Promise<AssetCacheResult>>;

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
            "SELECT file_path, size, checksum, last_accessed_at, created_at FROM asset_cache WHERE app = ? AND version = ? AND asset_name = ?"
        );
        this.insertStmt = this.db.prepare(
            "INSERT INTO asset_cache (app, version, asset_name, file_path, size, checksum, last_accessed_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)"
        );
        this.updateAccessStmt = this.db.prepare(
            "UPDATE asset_cache SET last_accessed_at = ? WHERE app = ? AND version = ? AND asset_name = ?"
        );
        this.deleteStmt = this.db.prepare("DELETE FROM asset_cache WHERE app = ? AND version = ? AND asset_name = ?");
        this.deleteAppStmt = this.db.prepare("DELETE FROM asset_cache WHERE app = ?");
        this.deleteAppVersionStmt = this.db.prepare("DELETE FROM asset_cache WHERE app = ? AND version = ?");
        this.deleteAppVersionAssetStmt = this.db.prepare(
            "DELETE FROM asset_cache WHERE app = ? AND version = ? AND asset_name = ?"
        );
        this.deleteAllStmt = this.db.prepare("DELETE FROM asset_cache");
        this.allStmt = this.db.prepare(
            "SELECT app, version, asset_name, file_path, size, checksum, last_accessed_at, created_at FROM asset_cache ORDER BY last_accessed_at ASC"
        );
        this.inFlight = new Map();
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

    purge(app?: string, version?: string, assetName?: string): void {
        let rows: FileToDeleteRow[];
        if (app !== undefined && version !== undefined && assetName !== undefined) {
            rows = this.queryFilesToDelete("app_version_asset", app, version, assetName);
            this.deleteAppVersionAssetStmt.run(app, version, assetName);
        } else if (app !== undefined && version !== undefined) {
            rows = this.queryFilesToDelete("app_version", app, version);
            this.deleteAppVersionStmt.run(app, version);
        } else if (app !== undefined) {
            rows = this.queryFilesToDelete("app", app);
            this.deleteAppStmt.run(app);
        } else {
            rows = this.queryFilesToDelete("all");
            this.deleteAllStmt.run();
        }
        for (let i = 0; i < rows.length; i = i + 1) {
            this.deleteFile(rows[i].file_path);
        }
        this.logger.info("Asset cache purged", {
            app: app,
            version: version,
            assetName: assetName,
            count: rows.length
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
                PRIMARY KEY (app, version, asset_name)
            );
            CREATE INDEX IF NOT EXISTS idx_asset_cache_app ON asset_cache(app);
            CREATE INDEX IF NOT EXISTS idx_asset_cache_access ON asset_cache(last_accessed_at);
            CREATE INDEX IF NOT EXISTS idx_asset_cache_created ON asset_cache(created_at);
        `);
    }

    private queryFilesToDelete(
        scope: "app_version_asset" | "app_version" | "app" | "all",
        app?: string,
        version?: string,
        assetName?: string
    ): FileToDeleteRow[] {
        if (scope === "app_version_asset") {
            return this.db
                .prepare("SELECT file_path FROM asset_cache WHERE app = ? AND version = ? AND asset_name = ?")
                .all(app, version, assetName) as FileToDeleteRow[];
        }
        if (scope === "app_version") {
            return this.db
                .prepare("SELECT file_path FROM asset_cache WHERE app = ? AND version = ?")
                .all(app, version) as FileToDeleteRow[];
        }
        if (scope === "app") {
            return this.db.prepare("SELECT file_path FROM asset_cache WHERE app = ?").all(app) as FileToDeleteRow[];
        }
        return this.db.prepare("SELECT file_path FROM asset_cache").all() as FileToDeleteRow[];
    }

    private async resolveAssetPath(app: string, version: string, asset: types.Asset): Promise<AssetCacheResult> {
        const cached = this.getStmt.get(app, version, asset.name) as AssetCacheRow | undefined;
        if (cached !== undefined) {
            const now = Date.now();
            if (now - cached.created_at > this.limits.maxAgeMs) {
                this.logger.info("Asset cache entry expired", { app: app, version: version, asset: asset.name });
                this.deleteEntry(app, version, asset.name, cached.file_path);
            } else {
                const checksum = await this.computeChecksum(cached.file_path);
                if (checksum === cached.checksum && fs.existsSync(cached.file_path)) {
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
                this.logger.warn("Asset cache checksum mismatch", { app: app, version: version, asset: asset.name });
                this.deleteEntry(app, version, asset.name, cached.file_path);
            }
        }
        this.metrics.recordCacheMiss("asset");
        return this.downloadAndCache(app, version, asset);
    }

    private async downloadAndCache(app: string, version: string, asset: types.Asset): Promise<AssetCacheResult> {
        const sanitizedApp = this.sanitizeName(app);
        const sanitizedVersion = this.sanitizeName(version);
        const sanitizedAssetName = this.sanitizeName(asset.name);
        const dir = path.join(this.cacheDir, sanitizedApp, sanitizedVersion);
        if (!fs.existsSync(dir)) {
            fs.mkdirSync(dir, { recursive: true });
        }
        const finalPath = path.join(dir, sanitizedAssetName);
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
            const now = Date.now();
            this.insertStmt.run(app, version, asset.name, finalPath, asset.size, checksum, now, now);
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

    private async makeRoom(neededSize: number): Promise<void> {
        const stats = this.getCacheStats();
        if (stats.totalSize + neededSize <= this.limits.maxSize && stats.totalCount + 1 <= this.limits.maxCount) {
            return;
        }
        const rows = this.allStmt.all() as AssetCacheRow[];
        for (let i = 0; i < rows.length; i = i + 1) {
            const row = rows[i];
            this.deleteEntry(row.app, row.version, row.asset_name, row.file_path);
            const newStats = this.getCacheStats();
            if (
                newStats.totalSize + neededSize <= this.limits.maxSize &&
                newStats.totalCount + 1 <= this.limits.maxCount
            ) {
                break;
            }
        }
    }

    private getCacheStats(): { totalSize: number; totalCount: number } {
        const rows = this.allStmt.all() as AssetCacheRow[];
        let totalSize = 0;
        for (let i = 0; i < rows.length; i = i + 1) {
            totalSize = totalSize + rows[i].size;
        }
        return { totalSize: totalSize, totalCount: rows.length };
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

    private sanitizeName(name: string): string {
        return name.replace(/[^a-zA-Z0-9._-]/g, "_").replace(/_+/g, "_");
    }
}
