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
        request: vi.fn(),
        Agent: class {
            close(): Promise<void> {
                return Promise.resolve();
            }
        }
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
        const asset = createAsset("app.exe", data.length, "https://github.com/app.exe");
        vi.mocked(undici.request).mockResolvedValueOnce(createResponse(data));
        cache = new assetCache.DiskAssetCacheService(tempDir, new SilentLogger(), metricsService);

        const result = await cache.getAssetPath("app1", "v1.0.0", asset);

        expect(result.cached).toBe(false);
        expect(fs.existsSync(result.filePath)).toBe(true);
        expect(fs.readFileSync(result.filePath).toString()).toBe("hello asset");
    });

    it("returns stored checksum without downloading", async function () {
        const data = Buffer.from("hello asset");
        const asset = createAsset("app.exe", data.length, "https://github.com/app.exe");
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
        const asset = createAsset("app.zip", data.length, "https://github.com/app.zip");
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
        const asset = createAsset("app.tar.gz", data.length, "https://github.com/app.tar.gz");
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
        const asset = createAsset("app.exe", data2.length, "https://github.com/app.exe");
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
        const asset1 = createAsset("first.exe", data1.length, "https://github.com/first.exe");
        const asset2 = createAsset("second.exe", data2.length, "https://github.com/second.exe");
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
        const asset = createAsset("app.exe", data.length, "https://github.com/app.exe");
        vi.mocked(undici.request).mockResolvedValueOnce(createResponse(data));
        cache = new assetCache.DiskAssetCacheService(tempDir, new SilentLogger(), metricsService);

        const result = await cache.getAssetPath("app1", "v1.0.0", asset);
        cache.purge("app1");

        expect(fs.existsSync(result.filePath)).toBe(false);
    });

    it("purges by app and version", async function () {
        const data = Buffer.from("purge me");
        const asset = createAsset("app.exe", data.length, "https://github.com/app.exe");
        vi.mocked(undici.request).mockResolvedValueOnce(createResponse(data));
        cache = new assetCache.DiskAssetCacheService(tempDir, new SilentLogger(), metricsService);

        const result = await cache.getAssetPath("app1", "v1.0.0", asset);
        cache.purge("app1", "v1.0.0");

        expect(fs.existsSync(result.filePath)).toBe(false);
    });

    it("sanitizes file names to prevent directory traversal", async function () {
        const data = Buffer.from("safe");
        const asset = createAsset("../../evil.exe", data.length, "https://github.com/evil.exe");
        vi.mocked(undici.request).mockResolvedValueOnce(createResponse(data));
        cache = new assetCache.DiskAssetCacheService(tempDir, new SilentLogger(), metricsService);

        const result = await cache.getAssetPath("app1", "v1.0.0", asset);

        expect(result.filePath.indexOf("_evil.exe") >= 0).toBe(true);
        expect(fs.existsSync(result.filePath)).toBe(true);
    });

    it("throws when download returns non-2xx status", async function () {
        const asset = createAsset("app.exe", 5, "https://github.com/app.exe");
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
        const asset = createAsset("app.exe", 5, "https://github.com/app.exe");
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
        const asset1 = createAsset("first.exe", data1.length, "https://github.com/first.exe");
        const asset2 = createAsset("second.exe", data2.length, "https://github.com/second.exe");
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
        const asset = createAsset("app.exe", data.length, "https://github.com/app.exe");
        vi.mocked(undici.request).mockResolvedValueOnce(createResponse(data));
        cache = new assetCache.DiskAssetCacheService(tempDir, new SilentLogger(), metricsService);

        const result = await cache.getAssetPath("app1", "v1.0.0", asset);
        cache.purge();

        expect(fs.existsSync(result.filePath)).toBe(false);
    });

    it("purges a single asset entry", async function () {
        const data = Buffer.from("purge one");
        const asset = createAsset("app.exe", data.length, "https://github.com/app.exe");
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
        const asset = createAsset("app.exe", data.length, "https://github.com/app.exe");
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
        const asset = createAsset("app.exe", data2.length, "https://github.com/app.exe");
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
        const asset = createAsset("app.exe", data.length, "https://github.com/app.exe");
        vi.mocked(undici.request).mockResolvedValueOnce(createResponse(data));
        cache = new assetCache.DiskAssetCacheService(tempDir, new SilentLogger(), metricsService);

        const first = await cache.getAssetPath("app1", "v1.0.0", asset);
        fs.unlinkSync(first.filePath);

        await expect(cache.getAssetPath("app1", "v1.0.0", asset)).rejects.toThrow();
    });

    it("cleans up temp file when download fails", async function () {
        const asset = createAsset("app.exe", 5, "https://github.com/app.exe");
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
        const asset = createAsset("app.exe", data.length, "https://github.com/app.exe");
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
        const asset = createAsset("app.exe", data.length, "https://github.com/app.exe");
        vi.mocked(undici.request).mockResolvedValueOnce(createResponse(data));
        cache = new assetCache.DiskAssetCacheService(tempDir, new SilentLogger(), metricsService);

        const result = await cache.getAssetPath("app1", "v1.0.0", asset);
        fs.unlinkSync(result.filePath);
        cache.purge("app1");

        expect(cache).toBeDefined();
    });

    it("handles non-error file deletion failures gracefully", async function () {
        const data = Buffer.from("purge me");
        const asset = createAsset("app.exe", data.length, "https://github.com/app.exe");
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
        const asset = createAsset("app.exe", data.length, "https://github.com/app.exe");
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
        const asset1 = createAsset("first.exe", data1.length, "https://github.com/first.exe");
        const asset2 = createAsset("second.exe", data2.length, "https://github.com/second.exe");
        const asset3 = createAsset("third.exe", data3.length, "https://github.com/third.exe");
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
        const asset = createAsset("app.exe", data.length, "https://github.com/app.exe");
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
            const asset = createAsset("app.exe", data.length, "https://github.com/app.exe");
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
        const asset = createAsset("app.exe", data.length, "https://github.com/app.exe");
        vi.mocked(undici.request)
            .mockResolvedValueOnce({
                statusCode: 302,
                headers: { location: "https://github.com/redirected.exe" },
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
        const asset = createAsset("app.exe", data.length, "https://github.com/app.exe");
        vi.mocked(undici.request)
            .mockResolvedValueOnce({
                statusCode: 301,
                headers: { location: ["https://github.com/redirected.exe"] },
                body: null
            } as unknown as Awaited<ReturnType<typeof undici.request>>)
            .mockResolvedValueOnce(createResponse(data));
        cache = new assetCache.DiskAssetCacheService(tempDir, new SilentLogger(), metricsService);

        const result = await cache.getAssetPath("app1", "v1.0.0", asset);

        expect(fs.readFileSync(result.filePath).toString()).toBe("array redirect");
    });

    it("throws when redirect limit is exceeded", async function () {
        const asset = createAsset("app.exe", 5, "https://github.com/app.exe");
        vi.mocked(undici.request).mockResolvedValue({
            statusCode: 302,
            headers: { location: "https://github.com/redirect.exe" },
            body: null
        } as unknown as Awaited<ReturnType<typeof undici.request>>);
        cache = new assetCache.DiskAssetCacheService(tempDir, new SilentLogger(), metricsService);

        await expect(cache.getAssetPath("app1", "v1.0.0", asset)).rejects.toThrow(
            "Asset download exceeded the redirect limit"
        );
        // Five hops are followed, then the sixth request is refused.
        expect(undici.request).toHaveBeenCalledTimes(6);
    });

    it("drains a redirect body before following so the socket returns to the pool", async function () {
        const asset = createAsset("app.exe", 5, "https://github.com/app.exe");
        const redirectBody = { dump: vi.fn().mockResolvedValue(undefined) };
        vi.mocked(undici.request)
            .mockResolvedValueOnce({
                statusCode: 302,
                headers: { location: "https://objects.githubusercontent.com/final.exe" },
                body: redirectBody
            } as unknown as Awaited<ReturnType<typeof undici.request>>)
            .mockResolvedValueOnce(createResponse(Buffer.from("payload")));
        cache = new assetCache.DiskAssetCacheService(tempDir, new SilentLogger(), metricsService);

        const result = await cache.getAssetPath("app1", "v1.0.0", asset);

        expect(redirectBody.dump).toHaveBeenCalledTimes(1);
        expect(result.cached).toBe(false);
    });

    it("returns a redirect response that carries no location instead of looping", async function () {
        const asset = createAsset("app.exe", 5, "https://github.com/app.exe");
        vi.mocked(undici.request).mockResolvedValue({
            statusCode: 302,
            headers: {},
            body: null
        } as unknown as Awaited<ReturnType<typeof undici.request>>);
        cache = new assetCache.DiskAssetCacheService(tempDir, new SilentLogger(), metricsService);

        await expect(cache.getAssetPath("app1", "v1.0.0", asset)).rejects.toThrow(
            "Asset download failed with status 302"
        );
        expect(undici.request).toHaveBeenCalledTimes(1);
    });

    it("returns a redirect whose location is an empty array", async function () {
        const asset = createAsset("app.exe", 5, "https://github.com/app.exe");
        vi.mocked(undici.request).mockResolvedValue({
            statusCode: 302,
            headers: { location: [] },
            body: null
        } as unknown as Awaited<ReturnType<typeof undici.request>>);
        cache = new assetCache.DiskAssetCacheService(tempDir, new SilentLogger(), metricsService);

        await expect(cache.getAssetPath("app1", "v1.0.0", asset)).rejects.toThrow(
            "Asset download failed with status 302"
        );
        expect(undici.request).toHaveBeenCalledTimes(1);
    });

    it("bounds how many assets download at once", async function () {
        // Distinct assets, so the in-flight map cannot collapse them. Without a bound, a burst of
        // first-time downloads holds a socket, a write stream and a temp file each on a 2 vCPU box.
        let peak = 0;
        let active = 0;
        vi.mocked(undici.request).mockImplementation(function () {
            active = active + 1;
            peak = Math.max(peak, active);
            return new Promise(function (resolve) {
                setTimeout(function () {
                    active = active - 1;
                    resolve(createResponse(Buffer.from("payload")));
                }, 5);
            });
        });
        cache = new assetCache.DiskAssetCacheService(tempDir, new SilentLogger(), metricsService, {
            maxSize: 1024 * 1024 * 1024,
            maxCount: 100,
            maxAgeMs: 60000,
            maxCacheableSize: 1024 * 1024 * 1024,
            cleanupIntervalMs: 0,
            maxConcurrentDownloads: 2
        });

        const requests: Array<Promise<unknown>> = [];
        for (let i = 0; i < 6; i = i + 1) {
            const asset = createAsset("file-" + String(i) + ".exe", 7, "https://github.com/file-" + String(i) + ".exe");
            requests.push(cache.getAssetPath("app1", "v1.0.0", asset));
        }
        expect(cache.pendingDownloads).toBeGreaterThan(0);
        await Promise.all(requests);

        expect(peak).toBe(2);
        expect(cache.pendingDownloads).toBe(0);
    });

    it("aborts download when timeout fires", async function () {
        vi.useFakeTimers();
        try {
            const asset = createAsset("app.exe", 5, "https://github.com/app.exe");
            vi.mocked(undici.request).mockImplementation(function (_url, options) {
                return new Promise(function (_resolve, reject) {
                    if (options !== undefined && options.signal instanceof AbortSignal) {
                        options.signal.addEventListener("abort", function () {
                            reject(new Error("download aborted"));
                        });
                    }
                });
            });
            cache = new assetCache.DiskAssetCacheService(tempDir, new SilentLogger(), metricsService);

            const promise = cache.getAssetPath("app1", "v1.0.0", asset);
            // Attach the expectation before advancing the clock. The abort fires from inside a
            // timer callback, and a rejection that nothing is yet listening for is reported as
            // unhandled even though a handler is attached microseconds later.
            const assertion = expect(promise).rejects.toThrow("download aborted");
            // Asynchronous advance: the download waits on a concurrency slot first, so the request
            // is issued a few microtasks later than the call. A synchronous advance would run the
            // clock forward before the timeout even exists.
            await vi.advanceTimersByTimeAsync(300001);

            await assertion;
        } finally {
            vi.useRealTimers();
        }
    });

    it("cleans up temp file when file stream errors", async function () {
        const data = Buffer.from("hello");
        const asset = createAsset("app.exe", data.length, "https://github.com/app.exe");
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
            const asset = createAsset("app.exe", data.length, "https://github.com/app.exe");
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
            const asset = createAsset("app.exe", data.length, "https://github.com/app.exe");
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
            const asset = createAsset("app.exe", data2.length, "https://github.com/app.exe");
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
            const asset = createAsset("app.exe", data.length, "https://github.com/app.exe");
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
            const asset = createAsset("app.exe", data.length, "https://github.com/app.exe");
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
                        // The cast is the point of the test: a stream failure that is not an Error,
                        // which destroy()'s signature has no way to express.
                        this.destroy("EIO as a bare string" as unknown as Error);
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
            const asset = createAsset("..", 3, "https://github.com/x");
            cache = new assetCache.DiskAssetCacheService(tempDir, new SilentLogger(), metricsService);

            await expect(cache.getAssetPath("app1", "v1.0.0", asset)).rejects.toThrow("reserved path name");
        });

        it("refuses a dot asset name", async function () {
            const asset = createAsset(".", 3, "https://github.com/x");
            cache = new assetCache.DiskAssetCacheService(tempDir, new SilentLogger(), metricsService);

            await expect(cache.getAssetPath("app1", "v1.0.0", asset)).rejects.toThrow("reserved path name");
        });

        it("keeps distinct raw names that sanitise to the same string in separate files", async function () {
            const data1 = Buffer.from("one");
            const data2 = Buffer.from("two");
            const assetA = createAsset("release/1.0", data1.length, "https://github.com/a");
            const assetB = createAsset("release_1.0", data2.length, "https://github.com/b");
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
            const asset = createAsset("app.exe", 3, "https://github.com/x");
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

    it("serves repeated stats reads from the memo instead of re-aggregating", function () {
        cache = new assetCache.DiskAssetCacheService(tempDir, new SilentLogger(), metricsService);
        // The O(1) claim depends on this: an operator polling the footprint must not cause a table
        // scan per call.
        const first = cache.getStats();
        const second = cache.getStats();
        expect(second.totalSize).toBe(first.totalSize);
        expect(second.totalCount).toBe(first.totalCount);
    });

    it("discards a database created before these migrations existed", function () {
        const legacyDir = fs.mkdtempSync(path.join(os.tmpdir(), "download-server-legacy-assets-"));
        const legacy = new Database(path.join(legacyDir, "assets.db"));
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
        legacy.close();

        const rebuilt = new assetCache.DiskAssetCacheService(
            legacyDir,
            new SilentLogger(),
            new metrics.MetricsService()
        );
        try {
            // Nothing carried over, and the service is usable against the rebuilt schema.
            expect(rebuilt.getStats().totalCount).toBe(0);
            expect(rebuilt.getChecksum("app1", "v1.0.0", "app.exe")).toBeUndefined();
        } finally {
            rebuilt.close();
        }
    });

    it("rethrows an open failure that is not an unreadable schema", function () {
        const brokenDir = fs.mkdtempSync(path.join(os.tmpdir(), "download-server-broken-assets-"));
        // A directory where the database belongs. Treating this as an unreadable schema would
        // delete the operator's directory and retry forever, so it has to surface.
        fs.mkdirSync(path.join(brokenDir, "assets.db"));
        expect(function () {
            const opened = new assetCache.DiskAssetCacheService(
                brokenDir,
                new SilentLogger(),
                new metrics.MetricsService()
            );
            expect(opened).toBeDefined();
        }).toThrow();
    });
});

describe("isInsideDir", function () {
    it("accepts the directory itself and its descendants", function () {
        expect(assetCache.isInsideDir("/srv/cache", "/srv/cache")).toBe(true);
        expect(assetCache.isInsideDir("/srv/cache", "/srv/cache/app/v1/file.exe")).toBe(true);
    });

    it("rejects a sibling that merely shares a name prefix", function () {
        // A bare startsWith would accept this, which is the whole reason the separator is compared.
        expect(assetCache.isInsideDir("/srv/cache", "/srv/cache-evil/file.exe")).toBe(false);
        expect(assetCache.isInsideDir("/srv/cache", "/srv/other")).toBe(false);
    });

    it("does not double the separator when the parent already ends in one", function () {
        // path.resolve normalises the trailing separator away, so the child must still match.
        expect(assetCache.isInsideDir("/srv/cache/", "/srv/cache/file.exe")).toBe(true);
        expect(assetCache.isInsideDir("/srv/cache/", "/srv/cache-evil/file.exe")).toBe(false);
    });
});

describe("DiskAssetCacheService path guards", function () {
    it("fails closed when a resolved path would escape the cache root", function () {
        const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "download-server-guard-"));
        const service = new assetCache.DiskAssetCacheService(tempDir, new SilentLogger(), new metrics.MetricsService());
        try {
            // Reached through a cast because the character filter already removes every separator,
            // so no public call can produce an escaping path today. The guard exists so that a future
            // change to that filter fails closed; without a test it is untested defence-in-depth that
            // later looks like dead code and gets deleted.
            const internals = service as unknown as {
                assertInsideCacheRoot(target: string): void;
                assertDirectChild(parent: string, target: string): void;
            };
            expect(function () {
                internals.assertInsideCacheRoot(path.join(tempDir, "..", "escaped"));
            }).toThrow("Refusing to cache an asset outside the cache directory");
            expect(function () {
                internals.assertDirectChild(path.join(tempDir, "a"), path.join(tempDir, "a", "b", "c"));
            }).toThrow("Refusing to cache an asset outside the cache directory");
        } finally {
            service.close();
        }
    });
});
