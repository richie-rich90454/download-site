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
import * as types from "../../../src/shared/types.js";
import * as metrics from "../../../src/server/telemetry/metrics.js";
import * as assetCache from "../../../src/server/cache/asset-cache.js";
import { SilentLogger } from "../test-helpers.js";

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
        const limits: assetCache.AssetCacheLimits = { maxSize: 100 * 1024 * 1024, maxCount: 100, maxAgeMs: 1 };
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
        const limits: assetCache.AssetCacheLimits = { maxSize: 100 * 1024 * 1024, maxCount: 100, maxAgeMs: 1 };
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
});
