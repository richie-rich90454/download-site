/**
 * @vitest-environment node
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as stream from "node:stream";
import * as undici from "undici";
import Database from "better-sqlite3";
import * as types from "../../../src/shared/types.js";
import * as metrics from "../../../src/server/telemetry/metrics.js";
import * as assetCache from "../../../src/server/cache/asset-cache.js";
import { RecordingLogger, SilentLogger } from "../test-helpers.js";

vi.mock("undici", function () {
    return {
        request: vi.fn()
    };
});

vi.mock("node:fs", async function () {
    const actual = await vi.importActual<typeof import("node:fs")>("node:fs");
    return Object.assign({}, actual, {
        existsSync: vi.fn(actual.existsSync),
        unlinkSync: vi.fn(actual.unlinkSync)
    });
});

function createAsset(name: string, size: number, url: string): types.Asset {
    return {
        name: name,
        size: size,
        contentType: "application/octet-stream",
        url: url,
        browserDownloadUrl: url
    };
}

function createResponse(body: Buffer): Awaited<ReturnType<typeof undici.request>> {
    const readable = new stream.Readable({
        read: function () {
            this.push(body);
            this.push(null);
        }
    });
    return {
        statusCode: 200,
        headers: {},
        body: readable
    } as unknown as Awaited<ReturnType<typeof undici.request>>;
}

describe("DiskAssetCacheService", function () {
    let tempDir: string;
    let metricsService: metrics.MetricsService;
    let cache: assetCache.DiskAssetCacheService;

    beforeEach(function () {
        tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "download-server-asset-"));
        metricsService = new metrics.MetricsService();
    });

    afterEach(function () {
        cache.close();
        fs.rmSync(tempDir, { recursive: true, force: true });
        vi.mocked(undici.request).mockReset();
    });

    it("downloads and caches an asset", async function () {
        const data = Buffer.from("hello asset");
        const asset = createAsset("app.exe", data.length, "http://example.com/app.exe");
        vi.mocked(undici.request).mockResolvedValueOnce(createResponse(data));
        cache = new assetCache.DiskAssetCacheService(tempDir, new SilentLogger(), metricsService);

        const result = await cache.getAssetPath("app1", "v1.0.0", asset);

        expect(result.cached).toBe(false);
        expect(fs.existsSync(result.filePath)).toBe(true);
        expect(fs.readFileSync(result.filePath).toString()).toBe("hello asset");
    });

    it("returns stored checksum without downloading", async function () {
        const data = Buffer.from("hello asset");
        const asset = createAsset("app.exe", data.length, "http://example.com/app.exe");
        const expectedChecksum = crypto.createHash("sha256").update(data).digest("hex");
        vi.mocked(undici.request).mockResolvedValueOnce(createResponse(data));
        cache = new assetCache.DiskAssetCacheService(tempDir, new SilentLogger(), metricsService);

        await cache.getAssetPath("app1", "v1.0.0", asset);
        const checksum = cache.getChecksum("app1", "v1.0.0", "app.exe");

        expect(checksum).toBe(expectedChecksum);
    });

    it("returns undefined checksum for uncached asset", async function () {
        cache = new assetCache.DiskAssetCacheService(tempDir, new SilentLogger(), metricsService);

        const checksum = cache.getChecksum("app1", "v1.0.0", "missing.exe");

        expect(checksum).toBeUndefined();
    });

    it("returns cached path on second request", async function () {
        const data = Buffer.from("cached asset");
        const asset = createAsset("app.zip", data.length, "http://example.com/app.zip");
        vi.mocked(undici.request).mockResolvedValueOnce(createResponse(data));
        cache = new assetCache.DiskAssetCacheService(tempDir, new SilentLogger(), metricsService);

        const first = await cache.getAssetPath("app1", "v1.0.0", asset);
        const second = await cache.getAssetPath("app1", "v1.0.0", asset);

        expect(first.cached).toBe(false);
        expect(second.cached).toBe(true);
        expect(second.filePath).toBe(first.filePath);
    });

    it("coalesces concurrent downloads of same asset", async function () {
        const data = Buffer.from("coalesced");
        const asset = createAsset("app.tar.gz", data.length, "http://example.com/app.tar.gz");
        vi.mocked(undici.request).mockResolvedValueOnce(createResponse(data));
        cache = new assetCache.DiskAssetCacheService(tempDir, new SilentLogger(), metricsService);

        const promise1 = cache.getAssetPath("app1", "v1.0.0", asset);
        const promise2 = cache.getAssetPath("app1", "v1.0.0", asset);
        const results = await Promise.all([promise1, promise2]);

        expect(results[0].filePath).toBe(results[1].filePath);
        expect(undici.request).toHaveBeenCalledTimes(1);
    });

    it("re-downloads when checksum mismatches", async function () {
        const data1 = Buffer.from("first");
        const data2 = Buffer.from("second");
        const asset = createAsset("app.exe", data2.length, "http://example.com/app.exe");
        vi.mocked(undici.request)
            .mockResolvedValueOnce(createResponse(data1))
            .mockResolvedValueOnce(createResponse(data2));
        cache = new assetCache.DiskAssetCacheService(tempDir, new SilentLogger(), metricsService);

        await cache.getAssetPath("app1", "v1.0.0", asset);
        const filePath = path.join(tempDir, "assets", "app1", "v1.0.0", "app.exe");
        fs.writeFileSync(filePath, "corrupted");
        const result = await cache.getAssetPath("app1", "v1.0.0", asset);

        expect(fs.readFileSync(result.filePath).toString()).toBe("second");
        expect(undici.request).toHaveBeenCalledTimes(2);
    });

    it("evicts old entries when max count exceeded", async function () {
        const limits: assetCache.AssetCacheLimits = {
            maxSize: 100 * 1024 * 1024,
            maxCount: 1,
            maxAgeMs: 60 * 60 * 1000
        };
        cache = new assetCache.DiskAssetCacheService(tempDir, new SilentLogger(), metricsService, limits);
        const data1 = Buffer.from("first asset");
        const data2 = Buffer.from("second asset");
        const asset1 = createAsset("first.exe", data1.length, "http://example.com/first.exe");
        const asset2 = createAsset("second.exe", data2.length, "http://example.com/second.exe");
        vi.mocked(undici.request)
            .mockResolvedValueOnce(createResponse(data1))
            .mockResolvedValueOnce(createResponse(data2));

        await cache.getAssetPath("app1", "v1.0.0", asset1);
        await cache.getAssetPath("app1", "v1.1.0", asset2);

        expect(fs.existsSync(path.join(tempDir, "assets", "app1", "v1.0.0", "first.exe"))).toBe(false);
        expect(fs.existsSync(path.join(tempDir, "assets", "app1", "v1.1.0", "second.exe"))).toBe(true);
    });

    it("purges by app", async function () {
        const data = Buffer.from("purge me");
        const asset = createAsset("app.exe", data.length, "http://example.com/app.exe");
        vi.mocked(undici.request).mockResolvedValueOnce(createResponse(data));
        cache = new assetCache.DiskAssetCacheService(tempDir, new SilentLogger(), metricsService);

        const result = await cache.getAssetPath("app1", "v1.0.0", asset);
        cache.purge("app1");

        expect(fs.existsSync(result.filePath)).toBe(false);
    });

    it("purges by app and version", async function () {
        const data = Buffer.from("purge me");
        const asset = createAsset("app.exe", data.length, "http://example.com/app.exe");
        vi.mocked(undici.request).mockResolvedValueOnce(createResponse(data));
        cache = new assetCache.DiskAssetCacheService(tempDir, new SilentLogger(), metricsService);

        const result = await cache.getAssetPath("app1", "v1.0.0", asset);
        cache.purge("app1", "v1.0.0");

        expect(fs.existsSync(result.filePath)).toBe(false);
    });

    it("sanitizes file names to prevent directory traversal", async function () {
        const data = Buffer.from("safe");
        const asset = createAsset("../../evil.exe", data.length, "http://example.com/evil.exe");
        vi.mocked(undici.request).mockResolvedValueOnce(createResponse(data));
        cache = new assetCache.DiskAssetCacheService(tempDir, new SilentLogger(), metricsService);

        const result = await cache.getAssetPath("app1", "v1.0.0", asset);

        expect(result.filePath.indexOf("_evil.exe") >= 0).toBe(true);
        expect(fs.existsSync(result.filePath)).toBe(true);
    });

    it("throws when download returns non-2xx status", async function () {
        const asset = createAsset("app.exe", 5, "http://example.com/app.exe");
        vi.mocked(undici.request).mockResolvedValueOnce({
            statusCode: 404,
            headers: {},
            body: null
        } as unknown as Awaited<ReturnType<typeof undici.request>>);
        cache = new assetCache.DiskAssetCacheService(tempDir, new SilentLogger(), metricsService);

        await expect(cache.getAssetPath("app1", "v1.0.0", asset)).rejects.toThrow(
            "Asset download failed with status 404"
        );
    });

    it("throws when download response body is empty", async function () {
        const asset = createAsset("app.exe", 5, "http://example.com/app.exe");
        vi.mocked(undici.request).mockResolvedValueOnce({
            statusCode: 200,
            headers: {},
            body: null
        } as unknown as Awaited<ReturnType<typeof undici.request>>);
        cache = new assetCache.DiskAssetCacheService(tempDir, new SilentLogger(), metricsService);

        await expect(cache.getAssetPath("app1", "v1.0.0", asset)).rejects.toThrow(
            "Asset download response body is empty"
        );
    });

    it("evicts old entries when max size exceeded", async function () {
        const limits: assetCache.AssetCacheLimits = { maxSize: 20, maxCount: 100, maxAgeMs: 60 * 60 * 1000 };
        cache = new assetCache.DiskAssetCacheService(tempDir, new SilentLogger(), metricsService, limits);
        const data1 = Buffer.from("first asset content");
        const data2 = Buffer.from("second asset content");
        const asset1 = createAsset("first.exe", data1.length, "http://example.com/first.exe");
        const asset2 = createAsset("second.exe", data2.length, "http://example.com/second.exe");
        vi.mocked(undici.request)
            .mockResolvedValueOnce(createResponse(data1))
            .mockResolvedValueOnce(createResponse(data2));

        await cache.getAssetPath("app1", "v1.0.0", asset1);
        await cache.getAssetPath("app1", "v1.1.0", asset2);

        expect(fs.existsSync(path.join(tempDir, "assets", "app1", "v1.0.0", "first.exe"))).toBe(false);
        expect(fs.existsSync(path.join(tempDir, "assets", "app1", "v1.1.0", "second.exe"))).toBe(true);
    });

    it("purges all entries when no scope is given", async function () {
        const data = Buffer.from("purge all");
        const asset = createAsset("app.exe", data.length, "http://example.com/app.exe");
        vi.mocked(undici.request).mockResolvedValueOnce(createResponse(data));
        cache = new assetCache.DiskAssetCacheService(tempDir, new SilentLogger(), metricsService);

        const result = await cache.getAssetPath("app1", "v1.0.0", asset);
        cache.purge();

        expect(fs.existsSync(result.filePath)).toBe(false);
    });

    it("purges a single asset entry", async function () {
        const data = Buffer.from("purge one");
        const asset = createAsset("app.exe", data.length, "http://example.com/app.exe");
        vi.mocked(undici.request).mockResolvedValueOnce(createResponse(data));
        cache = new assetCache.DiskAssetCacheService(tempDir, new SilentLogger(), metricsService);

        const result = await cache.getAssetPath("app1", "v1.0.0", asset);
        cache.purge("app1", "v1.0.0", "app.exe");

        expect(fs.existsSync(result.filePath)).toBe(false);
    });

    it("removes expired entries during background cleanup", async function () {
        const limits: assetCache.AssetCacheLimits = {
            maxSize: 100 * 1024 * 1024,
            maxCount: 100,
            maxAgeMs: 1,
            cleanupIntervalMs: 0
        };
        cache = new assetCache.DiskAssetCacheService(tempDir, new SilentLogger(), metricsService, limits);
        const data = Buffer.from("expiring soon");
        const asset = createAsset("app.exe", data.length, "http://example.com/app.exe");
        vi.mocked(undici.request).mockResolvedValueOnce(createResponse(data));

        const result = await cache.getAssetPath("app1", "v1.0.0", asset);
        await new Promise(function (resolve) {
            setTimeout(resolve, 50);
        });
        const serviceRecord = cache as unknown as Record<string, () => void>;
        serviceRecord.runCleanup();

        expect(fs.existsSync(result.filePath)).toBe(false);
    });

    it("re-downloads when cached entry is expired", async function () {
        const limits: assetCache.AssetCacheLimits = {
            maxSize: 100 * 1024 * 1024,
            maxCount: 100,
            maxAgeMs: 1,
            cleanupIntervalMs: 0
        };
        cache = new assetCache.DiskAssetCacheService(tempDir, new SilentLogger(), metricsService, limits);
        const data1 = Buffer.from("first");
        const data2 = Buffer.from("second");
        const asset = createAsset("app.exe", data2.length, "http://example.com/app.exe");
        vi.mocked(undici.request)
            .mockResolvedValueOnce(createResponse(data1))
            .mockResolvedValueOnce(createResponse(data2));

        await cache.getAssetPath("app1", "v1.0.0", asset);
        await new Promise(function (resolve) {
            setTimeout(resolve, 50);
        });
        const result = await cache.getAssetPath("app1", "v1.0.0", asset);

        expect(fs.readFileSync(result.filePath).toString()).toBe("second");
    });

    it("rejects when cached file is missing", async function () {
        const data = Buffer.from("first");
        const asset = createAsset("app.exe", data.length, "http://example.com/app.exe");
        vi.mocked(undici.request).mockResolvedValueOnce(createResponse(data));
        cache = new assetCache.DiskAssetCacheService(tempDir, new SilentLogger(), metricsService);

        const first = await cache.getAssetPath("app1", "v1.0.0", asset);
        fs.unlinkSync(first.filePath);

        await expect(cache.getAssetPath("app1", "v1.0.0", asset)).rejects.toThrow();
    });

    it("cleans up temp file when download fails", async function () {
        const asset = createAsset("app.exe", 5, "http://example.com/app.exe");
        vi.mocked(undici.request).mockResolvedValueOnce({
            statusCode: 500,
            headers: {},
            body: null
        } as unknown as Awaited<ReturnType<typeof undici.request>>);
        cache = new assetCache.DiskAssetCacheService(tempDir, new SilentLogger(), metricsService);

        await expect(cache.getAssetPath("app1", "v1.0.0", asset)).rejects.toThrow();

        const tempFiles = fs.readdirSync(path.join(tempDir, "assets", "app1", "v1.0.0"));
        expect(
            tempFiles.every(function (name) {
                return name.indexOf(".tmp") < 0;
            })
        ).toBe(true);
    });

    it("handles file deletion errors during purge gracefully", async function () {
        const data = Buffer.from("purge me");
        const asset = createAsset("app.exe", data.length, "http://example.com/app.exe");
        vi.mocked(undici.request).mockResolvedValueOnce(createResponse(data));
        cache = new assetCache.DiskAssetCacheService(tempDir, new SilentLogger(), metricsService);

        await cache.getAssetPath("app1", "v1.0.0", asset);
        const existsSpy = vi.spyOn(fs, "existsSync").mockReturnValue(true);
        const unlinkSpy = vi.spyOn(fs, "unlinkSync").mockImplementation(function () {
            throw new Error("cannot delete");
        });
        try {
            cache.purge("app1");
        } finally {
            existsSpy.mockRestore();
            unlinkSpy.mockRestore();
        }

        expect(cache).toBeDefined();
    });

    it("handles missing files during purge gracefully", async function () {
        const data = Buffer.from("missing");
        const asset = createAsset("app.exe", data.length, "http://example.com/app.exe");
        vi.mocked(undici.request).mockResolvedValueOnce(createResponse(data));
        cache = new assetCache.DiskAssetCacheService(tempDir, new SilentLogger(), metricsService);

        const result = await cache.getAssetPath("app1", "v1.0.0", asset);
        fs.unlinkSync(result.filePath);
        cache.purge("app1");

        expect(cache).toBeDefined();
    });

    it("handles non-error file deletion failures gracefully", async function () {
        const data = Buffer.from("purge me");
        const asset = createAsset("app.exe", data.length, "http://example.com/app.exe");
        vi.mocked(undici.request).mockResolvedValueOnce(createResponse(data));
        cache = new assetCache.DiskAssetCacheService(tempDir, new SilentLogger(), metricsService);

        await cache.getAssetPath("app1", "v1.0.0", asset);
        const existsSpy = vi.spyOn(fs, "existsSync").mockReturnValue(true);
        const unlinkSpy = vi.spyOn(fs, "unlinkSync").mockImplementation(function () {
            class CustomError extends Error {}
            throw new CustomError();
        });
        try {
            cache.purge("app1");
        } finally {
            existsSpy.mockRestore();
            unlinkSpy.mockRestore();
        }

        expect(cache).toBeDefined();
    });

    it("handles non-error thrown values during file deletion", async function () {
        const data = Buffer.from("purge me");
        const asset = createAsset("app.exe", data.length, "http://example.com/app.exe");
        vi.mocked(undici.request).mockResolvedValueOnce(createResponse(data));
        cache = new assetCache.DiskAssetCacheService(tempDir, new SilentLogger(), metricsService);

        await cache.getAssetPath("app1", "v1.0.0", asset);
        const existsSpy = vi.spyOn(fs, "existsSync").mockReturnValue(true);
        const unlinkSpy = vi.spyOn(fs, "unlinkSync").mockImplementation(function () {
            throw "not an error";
        });
        try {
            cache.purge("app1");
        } finally {
            existsSpy.mockRestore();
            unlinkSpy.mockRestore();
        }

        expect(cache).toBeDefined();
    });

    it("continues evicting until enough room is made", async function () {
        const limits: assetCache.AssetCacheLimits = { maxSize: 6, maxCount: 100, maxAgeMs: 60 * 60 * 1000 };
        cache = new assetCache.DiskAssetCacheService(tempDir, new SilentLogger(), metricsService, limits);
        const data1 = Buffer.from("a");
        const data2 = Buffer.from("b");
        const data3 = Buffer.from("cccccc");
        const asset1 = createAsset("first.exe", data1.length, "http://example.com/first.exe");
        const asset2 = createAsset("second.exe", data2.length, "http://example.com/second.exe");
        const asset3 = createAsset("third.exe", data3.length, "http://example.com/third.exe");
        vi.mocked(undici.request)
            .mockResolvedValueOnce(createResponse(data1))
            .mockResolvedValueOnce(createResponse(data2))
            .mockResolvedValueOnce(createResponse(data3));

        await cache.getAssetPath("app1", "v1.0.0", asset1);
        await cache.getAssetPath("app1", "v1.1.0", asset2);
        await cache.getAssetPath("app1", "v1.2.0", asset3);

        expect(fs.existsSync(path.join(tempDir, "assets", "app1", "v1.0.0", "first.exe"))).toBe(false);
        expect(fs.existsSync(path.join(tempDir, "assets", "app1", "v1.1.0", "second.exe"))).toBe(false);
        expect(fs.existsSync(path.join(tempDir, "assets", "app1", "v1.2.0", "third.exe"))).toBe(true);
    });

    it("leaves unexpired entries during cleanup", async function () {
        const limits: assetCache.AssetCacheLimits = {
            maxSize: 100 * 1024 * 1024,
            maxCount: 100,
            maxAgeMs: 60 * 60 * 1000
        };
        cache = new assetCache.DiskAssetCacheService(tempDir, new SilentLogger(), metricsService, limits);
        const data = Buffer.from("fresh");
        const asset = createAsset("app.exe", data.length, "http://example.com/app.exe");
        vi.mocked(undici.request).mockResolvedValueOnce(createResponse(data));

        const result = await cache.getAssetPath("app1", "v1.0.0", asset);
        const serviceRecord = cache as unknown as Record<string, () => void>;
        serviceRecord.runCleanup();

        expect(fs.existsSync(result.filePath)).toBe(true);
    });

    it("runs background cleanup via interval", async function () {
        vi.useFakeTimers();
        try {
            const limits: assetCache.AssetCacheLimits = {
                maxSize: 100 * 1024 * 1024,
                maxCount: 100,
                maxAgeMs: 1
            };
            cache = new assetCache.DiskAssetCacheService(tempDir, new SilentLogger(), metricsService, limits);
            const data = Buffer.from("expiring soon");
            const asset = createAsset("app.exe", data.length, "http://example.com/app.exe");
            vi.mocked(undici.request).mockResolvedValueOnce(createResponse(data));

            const result = await cache.getAssetPath("app1", "v1.0.0", asset);
            vi.advanceTimersByTime(60001);

            expect(fs.existsSync(result.filePath)).toBe(false);
        } finally {
            vi.useRealTimers();
        }
    });

    it("follows a redirect when downloading an asset", async function () {
        const data = Buffer.from("redirected asset");
        const asset = createAsset("app.exe", data.length, "http://example.com/app.exe");
        vi.mocked(undici.request)
            .mockResolvedValueOnce({
                statusCode: 302,
                headers: { location: "http://example.com/redirected.exe" },
                body: null
            } as unknown as Awaited<ReturnType<typeof undici.request>>)
            .mockResolvedValueOnce(createResponse(data));
        cache = new assetCache.DiskAssetCacheService(tempDir, new SilentLogger(), metricsService);

        const result = await cache.getAssetPath("app1", "v1.0.0", asset);

        expect(fs.readFileSync(result.filePath).toString()).toBe("redirected asset");
        expect(undici.request).toHaveBeenCalledTimes(2);
    });

    it("handles redirect location provided as array", async function () {
        const data = Buffer.from("array redirect");
        const asset = createAsset("app.exe", data.length, "http://example.com/app.exe");
        vi.mocked(undici.request)
            .mockResolvedValueOnce({
                statusCode: 301,
                headers: { location: ["http://example.com/redirected.exe"] },
                body: null
            } as unknown as Awaited<ReturnType<typeof undici.request>>)
            .mockResolvedValueOnce(createResponse(data));
        cache = new assetCache.DiskAssetCacheService(tempDir, new SilentLogger(), metricsService);

        const result = await cache.getAssetPath("app1", "v1.0.0", asset);

        expect(fs.readFileSync(result.filePath).toString()).toBe("array redirect");
    });

    it("throws when redirect limit is exceeded", async function () {
        const asset = createAsset("app.exe", 5, "http://example.com/app.exe");
        vi.mocked(undici.request).mockResolvedValue({
            statusCode: 302,
            headers: { location: "http://example.com/redirect.exe" },
            body: null
        } as unknown as Awaited<ReturnType<typeof undici.request>>);
        cache = new assetCache.DiskAssetCacheService(tempDir, new SilentLogger(), metricsService);

        await expect(cache.getAssetPath("app1", "v1.0.0", asset)).rejects.toThrow(
            "Asset download redirect limit exceeded"
        );
    });

    it("aborts download when timeout fires", async function () {
        vi.useFakeTimers();
        try {
            const asset = createAsset("app.exe", 5, "http://example.com/app.exe");
            vi.mocked(undici.request).mockImplementation(function (_url, options) {
                const signal = options === undefined ? undefined : options.signal;
                return new Promise(function (_resolve, reject) {
                    if (signal !== undefined) {
                        signal.addEventListener("abort", function () {
                            reject(new Error("download aborted"));
                        });
                    }
                });
            });
            cache = new assetCache.DiskAssetCacheService(tempDir, new SilentLogger(), metricsService);

            const promise = cache.getAssetPath("app1", "v1.0.0", asset);
            vi.advanceTimersByTime(300001);

            await expect(promise).rejects.toThrow("download aborted");
        } finally {
            vi.useRealTimers();
        }
    });

    it("cleans up temp file when file stream errors", async function () {
        const data = Buffer.from("hello");
        const asset = createAsset("app.exe", data.length, "http://example.com/app.exe");
        const dateNowSpy = vi.spyOn(Date, "now").mockReturnValue(12345);
        const assetDir = path.join(tempDir, "assets", "app1", "v1.0.0");
        fs.mkdirSync(assetDir, { recursive: true });
        const tempPath = path.join(assetDir, "app.exe.tmp12345");
        fs.writeFileSync(tempPath, "");
        const errorStream = new stream.PassThrough();
        (errorStream as unknown as { on: (event: string, listener: (err: Error) => void) => void }).on = function (
            event: string,
            listener: (err: Error) => void
        ): void {
            if (event === "error") {
                listener(new Error("write failed"));
            }
        };
        const createWriteStreamSpy = vi
            .spyOn(fs, "createWriteStream")
            .mockReturnValue(errorStream as unknown as fs.WriteStream);
        vi.mocked(undici.request).mockResolvedValueOnce(createResponse(data));
        cache = new assetCache.DiskAssetCacheService(tempDir, new SilentLogger(), metricsService);

        await expect(cache.getAssetPath("app1", "v1.0.0", asset)).rejects.toThrow("write failed");
        expect(fs.existsSync(tempPath)).toBe(false);

        dateNowSpy.mockRestore();
        createWriteStreamSpy.mockRestore();
    });

    describe("O(1) hit validation", function () {
        it("serves a cache hit without re-hashing the file when size and mtime are unchanged", async function () {
            const data = Buffer.from("stable asset bytes");
            const asset = createAsset("app.exe", data.length, "http://example.com/app.exe");
            vi.mocked(undici.request).mockResolvedValue(createResponse(data));
            cache = new assetCache.DiskAssetCacheService(tempDir, new SilentLogger(), metricsService);
            await cache.getAssetPath("app1", "v1.0.0", asset);

            const readStreamSpy = vi.spyOn(fs, "createReadStream");
            const result = await cache.getAssetPath("app1", "v1.0.0", asset);

            expect(result.cached).toBe(true);
            // The whole point: a warm hit must not read the file at all. Any read stream here
            // would mean we are back to O(file size) per request.
            expect(readStreamSpy).not.toHaveBeenCalled();
            expect(undici.request).toHaveBeenCalledTimes(1);
            readStreamSpy.mockRestore();
        });

        it("re-verifies by hash when the file changed but the content is identical, then returns to O(1)", async function () {
            const data = Buffer.from("rewritten but identical");
            const asset = createAsset("app.exe", data.length, "http://example.com/app.exe");
            vi.mocked(undici.request).mockResolvedValue(createResponse(data));
            cache = new assetCache.DiskAssetCacheService(tempDir, new SilentLogger(), metricsService);
            const first = await cache.getAssetPath("app1", "v1.0.0", asset);
            expect(first.cached).toBe(false);

            // Rewrite identical bytes: mtime moves, hash still matches, so the entry is kept
            // and the new stat is adopted rather than triggering a re-download.
            const future = new Date(Date.now() + 5000);
            fs.writeFileSync(first.filePath, data);
            fs.utimesSync(first.filePath, future, future);

            const second = await cache.getAssetPath("app1", "v1.0.0", asset);

            expect(second.cached).toBe(true);
            expect(second.entry.checksum).toBe(first.entry.checksum);
            expect(undici.request).toHaveBeenCalledTimes(1);

            // And the adopted stat means the next read is O(1) again.
            const readStreamSpy = vi.spyOn(fs, "createReadStream");
            const third = await cache.getAssetPath("app1", "v1.0.0", asset);
            expect(third.cached).toBe(true);
            expect(readStreamSpy).not.toHaveBeenCalled();
            readStreamSpy.mockRestore();
        });

        it("re-downloads when the file is deleted underneath a valid row", async function () {
            const data1 = Buffer.from("first");
            const data2 = Buffer.from("second payload");
            const asset = createAsset("app.exe", data2.length, "http://example.com/app.exe");
            vi.mocked(undici.request)
                .mockResolvedValueOnce(createResponse(data1))
                .mockResolvedValueOnce(createResponse(data2));
            cache = new assetCache.DiskAssetCacheService(tempDir, new SilentLogger(), metricsService);
            const first = await cache.getAssetPath("app1", "v1.0.0", asset);
            fs.unlinkSync(first.filePath);

            const result = await cache.getAssetPath("app1", "v1.0.0", asset);

            expect(result.cached).toBe(false);
            expect(fs.readFileSync(result.filePath).toString()).toBe("second payload");
            expect(undici.request).toHaveBeenCalledTimes(2);
        });

        it("treats a file that cannot be read during verification as a miss", async function () {
            const data = Buffer.from("payload");
            const asset = createAsset("app.exe", data.length, "http://example.com/app.exe");
            vi.mocked(undici.request)
                .mockResolvedValueOnce(createResponse(data))
                .mockResolvedValueOnce(createResponse(data));
            const recorder = new RecordingLogger();
            cache = new assetCache.DiskAssetCacheService(tempDir, recorder, metricsService);
            const first = await cache.getAssetPath("app1", "v1.0.0", asset);

            // Force the stat to succeed and the subsequent hash read to fail.
            const future = new Date(Date.now() + 5000);
            fs.utimesSync(first.filePath, future, future);
            const readStreamSpy = vi.spyOn(fs, "createReadStream").mockImplementation(function () {
                const failing = new stream.Readable({
                    read: function () {
                        this.destroy(new Error("EIO simulated read failure"));
                    }
                });
                return failing as unknown as fs.ReadStream;
            });

            const result = await cache.getAssetPath("app1", "v1.0.0", asset);

            expect(result.cached).toBe(false);
            expect(undici.request).toHaveBeenCalledTimes(2);
            expect(recorder.messages("warn")).toContain("Asset cache file unreadable during verification");
            readStreamSpy.mockRestore();
        });
        it("handles a non-Error thrown while verifying a changed file", async function () {
            const data = Buffer.from("payload");
            const asset = createAsset("app.exe", data.length, "http://example.com/app.exe");
            vi.mocked(undici.request)
                .mockResolvedValueOnce(createResponse(data))
                .mockResolvedValueOnce(createResponse(data));
            const recorder = new RecordingLogger();
            cache = new assetCache.DiskAssetCacheService(tempDir, recorder, metricsService);
            const first = await cache.getAssetPath("app1", "v1.0.0", asset);

            const future = new Date(Date.now() + 5000);
            fs.utimesSync(first.filePath, future, future);
            const readStreamSpy = vi.spyOn(fs, "createReadStream").mockImplementation(function () {
                const failing = new stream.Readable({
                    read: function () {
                        this.destroy("EIO as a bare string");
                    }
                });
                return failing as unknown as fs.ReadStream;
            });

            const result = await cache.getAssetPath("app1", "v1.0.0", asset);

            expect(result.cached).toBe(false);
            const warning = recorder.entries.filter(function (entry) {
                return entry.message === "Asset cache file unreadable during verification";
            });
            expect(warning.length).toBe(1);
            expect(warning[0].context !== undefined ? warning[0].context.error : undefined).toBe(
                "EIO as a bare string"
            );
            readStreamSpy.mockRestore();
        });
    });

    describe("path traversal hardening", function () {
        it("refuses to cache an asset whose name is a reserved path segment", async function () {
            const asset = createAsset("..", 3, "http://example.com/x");
            cache = new assetCache.DiskAssetCacheService(tempDir, new SilentLogger(), metricsService);

            await expect(cache.getAssetPath("app1", "v1.0.0", asset)).rejects.toThrow("reserved path name");
        });

        it("refuses a dot asset name", async function () {
            const asset = createAsset(".", 3, "http://example.com/x");
            cache = new assetCache.DiskAssetCacheService(tempDir, new SilentLogger(), metricsService);

            await expect(cache.getAssetPath("app1", "v1.0.0", asset)).rejects.toThrow("reserved path name");
        });

        it("keeps distinct raw names that sanitise to the same string in separate files", async function () {
            const data1 = Buffer.from("one");
            const data2 = Buffer.from("two");
            const assetA = createAsset("release/1.0", data1.length, "http://example.com/a");
            const assetB = createAsset("release_1.0", data2.length, "http://example.com/b");
            vi.mocked(undici.request)
                .mockResolvedValueOnce(createResponse(data1))
                .mockResolvedValueOnce(createResponse(data2));
            cache = new assetCache.DiskAssetCacheService(tempDir, new SilentLogger(), metricsService);

            const first = await cache.getAssetPath("app1", "v1.0.0", assetA);
            const second = await cache.getAssetPath("app1", "v1.0.0", assetB);

            // Both sanitise to release_1.0, so only a digest suffix keeps them from colliding.
            expect(first.filePath).not.toBe(second.filePath);
            expect(fs.readFileSync(first.filePath).toString()).toBe("one");
            expect(fs.readFileSync(second.filePath).toString()).toBe("two");
        });

        it("refuses a version tag that sanitises to a reserved segment", async function () {
            const asset = createAsset("app.exe", 3, "http://example.com/x");
            cache = new assetCache.DiskAssetCacheService(tempDir, new SilentLogger(), metricsService);

            await expect(cache.getAssetPath("app1", "..", asset)).rejects.toThrow("reserved path name");
        });
    });

    it("runs the database in WAL mode so readers are not blocked by a writer", function () {
        cache = new assetCache.DiskAssetCacheService(tempDir, new SilentLogger(), metricsService);

        const dbPath = path.join(tempDir, "assets.db");
        const raw = new Database(dbPath, { readonly: true });
        const mode = raw.pragma("journal_mode", { simple: true });
        raw.close();

        expect(String(mode).toLowerCase()).toBe("wal");
    });

    it("migrates a database created before the stat columns existed", function () {
        // Build a database with exactly the pre-migration shape.
        const dbPath = path.join(tempDir, "assets.db");
        const legacy = new Database(dbPath);
        legacy.exec(`
            CREATE TABLE asset_cache (
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
        `);
        const legacyColumns = legacy.pragma("table_info(asset_cache)") as { name: string }[];
        legacy.close();
        expect(
            legacyColumns.map(function (c) {
                return c.name;
            })
        ).not.toContain("size_on_disk");

        // Constructing the service must add the columns without losing the existing rows.
        cache = new assetCache.DiskAssetCacheService(tempDir, new SilentLogger(), metricsService);
        cache.close();

        const verify = new Database(dbPath, { readonly: true });
        const columns = verify.pragma("table_info(asset_cache)") as { name: string }[];
        verify.close();
        const names = columns.map(function (c) {
            return c.name;
        });
        expect(names).toContain("size_on_disk");
        expect(names).toContain("mtime_ms");
    });

    it("reports cache stats from memoised counters in O(1)", async function () {
        const data = Buffer.from("counted bytes");
        const asset = createAsset("app.exe", data.length, "http://example.com/app.exe");
        vi.mocked(undici.request).mockResolvedValue(createResponse(data));
        cache = new assetCache.DiskAssetCacheService(tempDir, new SilentLogger(), metricsService);

        expect(cache.getStats()).toEqual({ totalSize: 0, totalCount: 0 });

        await cache.getAssetPath("app1", "v1.0.0", asset);
        const afterDownload = cache.getStats();
        expect(afterDownload.totalCount).toBe(1);

        // Repeated reads are served from the memo, and a returned copy cannot corrupt it.
        const again = cache.getStats();
        expect(again).toEqual(afterDownload);
        again.totalCount = 999;
        expect(cache.getStats().totalCount).toBe(1);
    });

    it("invalidates memoised stats after a purge", async function () {
        const data = Buffer.from("purge me");
        const asset = createAsset("app.exe", data.length, "http://example.com/app.exe");
        vi.mocked(undici.request).mockResolvedValue(createResponse(data));
        cache = new assetCache.DiskAssetCacheService(tempDir, new SilentLogger(), metricsService);
        await cache.getAssetPath("app1", "v1.0.0", asset);
        expect(cache.getStats().totalCount).toBe(1);

        cache.purge("app1", "v1.0.0");

        expect(cache.getStats().totalCount).toBe(0);
    });

    it("rejects an asset name that would resolve outside its cache directory", function () {
        cache = new assetCache.DiskAssetCacheService(tempDir, new SilentLogger(), metricsService);
        const internals = cache as unknown as {
            assertDirectChild: (parent: string, target: string) => void;
            assertInsideCacheRoot: (target: string) => void;
        };
        const dir = path.join(tempDir, "assets", "app1", "v1.0.0");

        // Bypasses the sanitiser to prove the containment invariant stands on its own, so a
        // future change to the character filter cannot silently reopen the traversal class.
        expect(function () {
            internals.assertDirectChild(dir, path.join(dir, "..", "escaped"));
        }).toThrow("outside the cache directory");
        expect(function () {
            internals.assertDirectChild(dir, path.join(dir, "nested", "deeper"));
        }).toThrow("outside the cache directory");
        expect(function () {
            internals.assertDirectChild(dir, path.join(dir, "fine.exe"));
        }).not.toThrow();

        expect(function () {
            internals.assertInsideCacheRoot(path.join(tempDir, "assets", "app1", "v1.0.0"));
        }).not.toThrow();
        expect(function () {
            internals.assertInsideCacheRoot(path.join(tempDir, "elsewhere"));
        }).toThrow("outside the cache directory");
    });

    describe("isInsideDir", function () {
        it("accepts a directory and its descendants", function () {
            const root = path.resolve(path.sep + "srv" + path.sep + "cache");
            expect(assetCache.isInsideDir(root, root)).toBe(true);
            expect(assetCache.isInsideDir(root, path.join(root, "app", "v1", "a.exe"))).toBe(true);
        });

        it("rejects siblings that merely share a name prefix", function () {
            const root = path.resolve(path.sep + "srv" + path.sep + "cache");
            expect(assetCache.isInsideDir(root, path.resolve(path.sep + "srv" + path.sep + "cache-evil"))).toBe(false);
        });

        it("rejects traversal above the root", function () {
            const root = path.resolve(path.sep + "srv" + path.sep + "cache");
            expect(assetCache.isInsideDir(root, path.join(root, "..", "..", "etc", "passwd"))).toBe(false);
            expect(assetCache.isInsideDir(root, path.resolve(path.sep + "etc" + path.sep + "passwd"))).toBe(false);
        });

        it("handles a parent that is already a filesystem root", function () {
            const fsRoot = path.parse(process.cwd()).root;
            expect(fsRoot.endsWith(path.sep)).toBe(true);
            expect(assetCache.isInsideDir(fsRoot, path.join(fsRoot, "srv", "cache"))).toBe(true);
            expect(assetCache.isInsideDir(fsRoot, fsRoot)).toBe(true);
        });
    });

    it("backfills size and mtime for rows written before those columns existed", async function () {
        const data = Buffer.from("legacy row");
        const asset = createAsset("app.exe", data.length, "http://example.com/app.exe");
        vi.mocked(undici.request).mockResolvedValue(createResponse(data));
        cache = new assetCache.DiskAssetCacheService(tempDir, new SilentLogger(), metricsService);
        await cache.getAssetPath("app1", "v1.0.0", asset);
        cache.close();

        // Simulate a pre-migration row: columns present but left at the sentinel.
        const dbPath = path.join(tempDir, "assets.db");
        const raw = new Database(dbPath);
        raw.prepare("UPDATE asset_cache SET size_on_disk = 0, mtime_ms = 0").run();
        raw.close();

        cache = new assetCache.DiskAssetCacheService(tempDir, new SilentLogger(), metricsService);
        const verify = new Database(dbPath, { readonly: true });
        const row = verify.prepare("SELECT size_on_disk, mtime_ms FROM asset_cache").get() as {
            size_on_disk: number;
            mtime_ms: number;
        };
        verify.close();

        expect(row.size_on_disk).toBe(data.length);
        expect(row.mtime_ms).toBeGreaterThan(0);
    });

    it("skips unreadable files during the stat backfill and leaves the sentinel in place", async function () {
        const data = Buffer.from("row with a vanished file");
        const asset = createAsset("app.exe", data.length, "http://example.com/app.exe");
        vi.mocked(undici.request).mockResolvedValue(createResponse(data));
        cache = new assetCache.DiskAssetCacheService(tempDir, new SilentLogger(), metricsService);
        await cache.getAssetPath("app1", "v1.0.0", asset);
        cache.close();

        const dbPath = path.join(tempDir, "assets.db");
        const raw = new Database(dbPath);
        raw.prepare("UPDATE asset_cache SET size_on_disk = 0, mtime_ms = 0").run();
        raw.prepare("UPDATE asset_cache SET file_path = ?").run(path.join(tempDir, "assets", "gone", "nope"));
        raw.close();

        // Must not throw: an unreadable path is logged and skipped, the row stays flagged for
        // slow re-verification on next read rather than being deleted.
        cache = new assetCache.DiskAssetCacheService(tempDir, new SilentLogger(), metricsService);
        cache.close();

        const verify = new Database(dbPath, { readonly: true });
        const row = verify.prepare("SELECT size_on_disk FROM asset_cache").get() as { size_on_disk: number };
        verify.close();

        expect(row.size_on_disk).toBe(0);
    });
});
