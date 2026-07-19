import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as fs from "node:fs";
import * as http from "node:http";
import * as os from "node:os";
import * as path from "node:path";
import * as stream from "node:stream";
import * as undici from "undici";
import * as types from "../../../src/shared/types.js";
import * as metrics from "../../../src/server/telemetry/metrics.js";
import * as downloadService from "../../../src/server/services/download-service.js";
import * as releaseService from "../../../src/server/services/release-service.js";
import * as assetCache from "../../../src/server/cache/asset-cache.js";
import * as platform from "../../../src/server/platform/platform-detector.js";
import { SilentLogger } from "../test-helpers.js";

vi.mock("undici", function () {
    return {
        request: vi.fn()
    };
});

class MockReleaseService {
    private releases: Record<string, types.Release> = {};

    addRelease(release: types.Release): void {
        this.releases[release.tag] = release;
    }

    async getLatestRelease(): Promise<types.Release | undefined> {
        return this.releases["v1.0.0"];
    }

    async getReleaseByTag(appId: string, tag: string): Promise<types.Release | undefined> {
        return this.releases[tag];
    }
}

class MockAssetCache implements assetCache.AssetCacheService {
    private files: Record<string, string> = {};

    register(app: string, version: string, assetName: string, filePath: string): void {
        this.files[app + "/" + version + "/" + assetName] = filePath;
    }

    async getAssetPath(app: string, version: string, asset: types.Asset): Promise<assetCache.AssetCacheResult> {
        const filePath = this.files[app + "/" + version + "/" + asset.name];
        return {
            filePath: filePath,
            cached: true,
            entry: {
                app: app,
                version: version,
                assetName: asset.name,
                filePath: filePath,
                size: asset.size,
                checksum: "",
                lastAccessedAt: Date.now(),
                createdAt: Date.now()
            }
        };
    }

    getChecksum(): string | undefined {
        return undefined;
    }

    purge(): void {
        // no-op
    }

    close(): void {
        // no-op
    }
}

function createRelease(tag: string): types.Release {
    return {
        tag: tag,
        name: "Release " + tag,
        notes: "Notes",
        publishedAt: "2024-01-01T00:00:00Z",
        prerelease: false,
        assets: [
            {
                name: "app-windows.exe",
                size: 100,
                contentType: "application/octet-stream",
                url: "http://example.com/app-windows.exe",
                browserDownloadUrl: "http://example.com/app-windows.exe"
            },
            {
                name: "app-macos.dmg",
                size: 100,
                contentType: "application/x-apple-diskimage",
                url: "http://example.com/app-macos.dmg",
                browserDownloadUrl: "http://example.com/app-macos.dmg"
            }
        ]
    };
}

describe("DownloadService", function () {
    let tempDir: string;
    let releaseSvc: MockReleaseService;
    let assetCacheSvc: MockAssetCache;
    let service: downloadService.DownloadService;

    beforeEach(function () {
        tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "download-server-download-"));
        releaseSvc = new MockReleaseService();
        assetCacheSvc = new MockAssetCache();
        service = new downloadService.DownloadService(
            releaseSvc as unknown as releaseService.ReleaseService,
            assetCacheSvc,
            new platform.DefaultPlatformDetector(),
            new metrics.MetricsService(),
            new SilentLogger(),
            "http://localhost:3000"
        );
    });

    afterEach(function () {
        fs.rmSync(tempDir, { recursive: true, force: true });
        vi.mocked(undici.request).mockReset();
    });

    it("resolves asset by platform", async function () {
        const release = createRelease("v1.0.0");
        releaseSvc.addRelease(release);
        const filePath = path.join(tempDir, "app-windows.exe");
        fs.writeFileSync(filePath, "binary");
        assetCacheSvc.register("app1", "v1.0.0", "app-windows.exe", filePath);

        const result = await service.resolveAsset("app1", { userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64)" });

        expect(result.asset.name).toBe("app-windows.exe");
        expect(result.release.tag).toBe("v1.0.0");
        expect(result.filePath).toBe(filePath);
    });

    it("resolves explicit asset by name", async function () {
        const release = createRelease("v1.0.0");
        releaseSvc.addRelease(release);
        const filePath = path.join(tempDir, "app-macos.dmg");
        fs.writeFileSync(filePath, "binary");
        assetCacheSvc.register("app1", "v1.0.0", "app-macos.dmg", filePath);

        const result = await service.resolveAsset("app1", { version: "v1.0.0", assetName: "app-macos.dmg" });

        expect(result.asset.name).toBe("app-macos.dmg");
    });

    it("throws when release not found", async function () {
        await expect(service.resolveAsset("app1", {})).rejects.toThrow("Release not found for app app1");
    });

    it("throws when no matching asset", async function () {
        const release = createRelease("v1.0.0");
        release.assets = [];
        releaseSvc.addRelease(release);

        await expect(service.resolveAsset("app1", { userAgent: "Windows" })).rejects.toThrow(
            "No matching asset found for app app1"
        );
    });

    it("throws when explicit asset name is not found", async function () {
        const release = createRelease("v1.0.0");
        releaseSvc.addRelease(release);

        await expect(service.resolveAsset("app1", { version: "v1.0.0", assetName: "missing.exe" })).rejects.toThrow(
            "No matching asset found for app app1"
        );
    });

    it("builds asset URL", function () {
        const url = service.buildAssetUrl("app1", "v1.0.0", "app-windows.exe");

        expect(url).toBe("http://localhost:3000/download/app1?version=v1.0.0&asset=app-windows.exe");
    });

    function requestServer(
        filePath: string,
        assetName: string,
        rangeHeader?: string
    ): Promise<{ statusCode: number; headers: http.IncomingHttpHeaders; body: string }> {
        return new Promise(function (resolve) {
            const server = http.createServer(function (req, res) {
                const range = req.headers.range;
                const header = rangeHeader !== undefined ? rangeHeader : Array.isArray(range) ? range[0] : range;
                service.serveFile(filePath, assetName, res, header);
            });
            server.listen(0, function () {
                const address = server.address();
                const port = typeof address === "object" && address !== null ? address.port : 0;
                const options: http.RequestOptions = { port: port, path: "/" };
                if (rangeHeader !== undefined) {
                    options.headers = { Range: rangeHeader };
                }
                http.get(options, function (res) {
                    let body = "";
                    res.on("data", function (chunk) {
                        body = body + chunk;
                    });
                    res.on("end", function () {
                        server.close(function () {
                            resolve({ statusCode: res.statusCode || 0, headers: res.headers, body: body });
                        });
                    });
                });
            });
        });
    }

    function createProxyResponse(
        body: Buffer,
        statusCode?: number,
        headers?: Record<string, string>
    ): Awaited<ReturnType<typeof undici.request>> {
        const actualStatusCode = statusCode === undefined ? 200 : statusCode;
        const actualHeaders = headers === undefined ? {} : headers;
        const readable = new stream.Readable({
            read: function () {
                this.push(body);
                this.push(null);
            }
        });
        return {
            statusCode: actualStatusCode,
            headers: actualHeaders,
            body: readable
        } as unknown as Awaited<ReturnType<typeof undici.request>>;
    }

    function proxyRequestServer(
        asset: types.Asset,
        release: types.Release,
        rangeHeader?: string
    ): Promise<{ statusCode: number; headers: http.IncomingHttpHeaders; body: string }> {
        return new Promise(function (resolve) {
            const server = http.createServer(function (_req, res) {
                const header = rangeHeader !== undefined ? rangeHeader : undefined;
                service.proxyDownload("app1", asset, release, res, header).catch(function (err) {
                    res.statusCode = 500;
                    res.end(err.message);
                });
            });
            server.listen(0, function () {
                const address = server.address();
                const port = typeof address === "object" && address !== null ? address.port : 0;
                const options: http.RequestOptions = { port: port, path: "/" };
                if (rangeHeader !== undefined) {
                    options.headers = { Range: rangeHeader };
                }
                http.get(options, function (res) {
                    let body = "";
                    res.on("data", function (chunk) {
                        body = body + chunk;
                    });
                    res.on("end", function () {
                        server.close(function () {
                            resolve({ statusCode: res.statusCode || 0, headers: res.headers, body: body });
                        });
                    });
                });
            });
        });
    }

    it("serves file with correct headers", async function () {
        const filePath = path.join(tempDir, "test.exe");
        fs.writeFileSync(filePath, "hello");

        const result = await requestServer(filePath, "test.exe");

        expect(result.statusCode).toBe(200);
        expect(result.headers["content-type"]).toBe("application/vnd.microsoft.portable-executable");
        expect(result.headers["content-disposition"]).toBe('attachment; filename="test.exe"');
        expect(result.body).toBe("hello");
    });

    it("supports range requests", async function () {
        const filePath = path.join(tempDir, "test.exe");
        fs.writeFileSync(filePath, "abcdef");

        const result = await requestServer(filePath, "test.exe", "bytes=1-3");

        expect(result.statusCode).toBe(206);
        expect(result.headers["content-range"]).toBe("bytes 1-3/6");
        expect(result.body).toBe("bcd");
    });

    it("returns 416 for invalid range format", async function () {
        const filePath = path.join(tempDir, "test.exe");
        fs.writeFileSync(filePath, "abcdef");

        const result = await requestServer(filePath, "test.exe", "bytes=invalid");

        expect(result.statusCode).toBe(416);
    });

    it("returns 416 for out of bounds range", async function () {
        const filePath = path.join(tempDir, "test.exe");
        fs.writeFileSync(filePath, "abcdef");

        const result = await requestServer(filePath, "test.exe", "bytes=10-20");

        expect(result.statusCode).toBe(416);
    });

    it("returns 416 when range start exceeds end", async function () {
        const filePath = path.join(tempDir, "test.exe");
        fs.writeFileSync(filePath, "abcdef");

        const result = await requestServer(filePath, "test.exe", "bytes=5-1");

        expect(result.statusCode).toBe(416);
    });

    it("supports range request with end only", async function () {
        const filePath = path.join(tempDir, "test.exe");
        fs.writeFileSync(filePath, "abcdef");

        const result = await requestServer(filePath, "test.exe", "bytes=-3");

        expect(result.statusCode).toBe(206);
        expect(result.headers["content-range"]).toBe("bytes 0-3/6");
        expect(result.body).toBe("abcd");
    });

    it("supports range request with start only", async function () {
        const filePath = path.join(tempDir, "test.exe");
        fs.writeFileSync(filePath, "abcdef");

        const result = await requestServer(filePath, "test.exe", "bytes=1-");

        expect(result.statusCode).toBe(206);
        expect(result.headers["content-range"]).toBe("bytes 1-5/6");
        expect(result.body).toBe("bcdef");
    });

    it("detects tar.gz content type", async function () {
        const filePath = path.join(tempDir, "test.tar.gz");
        fs.writeFileSync(filePath, "archive");

        const result = await requestServer(filePath, "test.tar.gz");

        expect(result.statusCode).toBe(200);
        expect(result.headers["content-type"]).toBe("application/gzip");
    });

    it("detects tar.gz content type from name fallback", async function () {
        const filePath = path.join(tempDir, "archive.tar.gz.asc");
        fs.writeFileSync(filePath, "archive");

        const result = await requestServer(filePath, "archive.tar.gz.asc");

        expect(result.statusCode).toBe(200);
        expect(result.headers["content-type"]).toBe("application/gzip");
    });

    it("uses default content type for unknown extension", async function () {
        const filePath = path.join(tempDir, "test.unknown");
        fs.writeFileSync(filePath, "data");

        const result = await requestServer(filePath, "test.unknown");

        expect(result.statusCode).toBe(200);
        expect(result.headers["content-type"]).toBe("application/octet-stream");
    });

    it("uses default content type when there is no extension", async function () {
        const filePath = path.join(tempDir, "README");
        fs.writeFileSync(filePath, "data");

        const result = await requestServer(filePath, "README");

        expect(result.statusCode).toBe(200);
        expect(result.headers["content-type"]).toBe("application/octet-stream");
    });

    it("calls hijack when serving through Fastify reply", function () {
        const filePath = path.join(tempDir, "fastify.exe");
        fs.writeFileSync(filePath, "hello-fastify");
        const raw = new http.ServerResponse({ method: "GET", url: "/" } as http.IncomingMessage);
        let hijackCalled = false;
        const reply = {
            hijack: function () {
                hijackCalled = true;
            },
            raw: raw
        };

        service.serveFile(filePath, "fastify.exe", reply as unknown as import("fastify").FastifyReply);

        expect(hijackCalled).toBe(true);
        expect(raw.statusCode).toBe(200);
        expect(raw.getHeader("Content-Disposition")).toBe('attachment; filename="fastify.exe"');
    });

    it("serves cached file with checksum header", async function () {
        const filePath = path.join(tempDir, "test.exe");
        fs.writeFileSync(filePath, "hello");

        const result = await requestServer(filePath, "test.exe", undefined);

        expect(result.statusCode).toBe(200);
        expect(result.headers["x-checksum-sha256"]).toBeUndefined();

        const raw = new http.ServerResponse({ method: "GET", url: "/" } as http.IncomingMessage);
        service.serveFile(filePath, "test.exe", raw, undefined, "abc123");

        expect(raw.getHeader("X-Checksum-SHA256")).toBe("abc123");
    });

    it("returns proxied result when asset exceeds max cacheable size", async function () {
        const release = createRelease("v1.0.0");
        release.assets[0].size = 100;
        releaseSvc.addRelease(release);
        const filePath = path.join(tempDir, "app-windows.exe");
        fs.writeFileSync(filePath, "binary");
        assetCacheSvc.register("app1", "v1.0.0", "app-windows.exe", filePath);
        const proxyService = new downloadService.DownloadService(
            releaseSvc as unknown as releaseService.ReleaseService,
            assetCacheSvc,
            new platform.DefaultPlatformDetector(),
            new metrics.MetricsService(),
            new SilentLogger(),
            "http://localhost:3000",
            { maxSize: 100 * 1024 * 1024, maxCount: 100, maxAgeMs: 60 * 60 * 1000, maxCacheableSize: 50 }
        );

        const result = await proxyService.resolveAsset("app1", { platformHint: "windows" });

        expect(result.proxied).toBe(true);
        expect(result.filePath).toBeUndefined();
    });

    it("returns cached result when asset is within max cacheable size", async function () {
        const release = createRelease("v1.0.0");
        release.assets[0].size = 10;
        releaseSvc.addRelease(release);
        const filePath = path.join(tempDir, "app-windows.exe");
        fs.writeFileSync(filePath, "binary");
        assetCacheSvc.register("app1", "v1.0.0", "app-windows.exe", filePath);
        const proxyService = new downloadService.DownloadService(
            releaseSvc as unknown as releaseService.ReleaseService,
            assetCacheSvc,
            new platform.DefaultPlatformDetector(),
            new metrics.MetricsService(),
            new SilentLogger(),
            "http://localhost:3000",
            { maxSize: 100 * 1024 * 1024, maxCount: 100, maxAgeMs: 60 * 60 * 1000, maxCacheableSize: 50 }
        );

        const result = await proxyService.resolveAsset("app1", { platformHint: "windows" });

        expect(result.proxied).toBe(false);
        expect(result.filePath).toBe(filePath);
    });

    it("proxies download with correct headers", async function () {
        const data = Buffer.from("proxied content");
        const asset: types.Asset = {
            name: "app.exe",
            size: 100,
            contentType: "application/vnd.microsoft.portable-executable",
            url: "http://example.com/app.exe",
            browserDownloadUrl: "http://example.com/app.exe"
        };
        const release: types.Release = {
            tag: "v1.0.0",
            name: "Release v1.0.0",
            notes: "Notes",
            publishedAt: "2024-01-01T00:00:00Z",
            prerelease: false,
            assets: [asset]
        };
        vi.mocked(undici.request).mockResolvedValueOnce(
            createProxyResponse(data, 200, { "content-length": String(data.length) })
        );

        const result = await proxyRequestServer(asset, release);

        expect(result.statusCode).toBe(200);
        expect(result.headers["content-type"]).toBe("application/vnd.microsoft.portable-executable");
        expect(result.headers["content-disposition"]).toBe('attachment; filename="app.exe"');
        expect(result.headers["accept-ranges"]).toBe("bytes");
        expect(result.headers["content-length"]).toBe(String(data.length));
        expect(result.body).toBe("proxied content");
    });

    it("proxies range requests", async function () {
        const asset: types.Asset = {
            name: "app.exe",
            size: 100,
            contentType: "application/octet-stream",
            url: "http://example.com/app.exe",
            browserDownloadUrl: "http://example.com/app.exe"
        };
        const release: types.Release = {
            tag: "v1.0.0",
            name: "Release v1.0.0",
            notes: "Notes",
            publishedAt: "2024-01-01T00:00:00Z",
            prerelease: false,
            assets: [asset]
        };
        vi.mocked(undici.request).mockResolvedValueOnce(
            createProxyResponse(Buffer.from("bcd"), 206, {
                "content-range": "bytes 1-3/6",
                "content-length": "3"
            })
        );

        const result = await proxyRequestServer(asset, release, "bytes=1-3");

        expect(result.statusCode).toBe(206);
        expect(result.headers["content-range"]).toBe("bytes 1-3/6");
        expect(result.body).toBe("bcd");
    });

    it("returns upstream error status during proxy download", async function () {
        const asset: types.Asset = {
            name: "app.exe",
            size: 100,
            contentType: "application/octet-stream",
            url: "http://example.com/app.exe",
            browserDownloadUrl: "http://example.com/app.exe"
        };
        const release: types.Release = {
            tag: "v1.0.0",
            name: "Release v1.0.0",
            notes: "Notes",
            publishedAt: "2024-01-01T00:00:00Z",
            prerelease: false,
            assets: [asset]
        };
        vi.mocked(undici.request).mockResolvedValueOnce({
            statusCode: 404,
            headers: {},
            body: null
        } as unknown as Awaited<ReturnType<typeof undici.request>>);

        const result = await proxyRequestServer(asset, release);

        expect(result.statusCode).toBe(404);
    });

    it("returns 502 when proxy download fetch fails", async function () {
        const asset: types.Asset = {
            name: "app.exe",
            size: 100,
            contentType: "application/octet-stream",
            url: "http://example.com/app.exe",
            browserDownloadUrl: "http://example.com/app.exe"
        };
        const release: types.Release = {
            tag: "v1.0.0",
            name: "Release v1.0.0",
            notes: "Notes",
            publishedAt: "2024-01-01T00:00:00Z",
            prerelease: false,
            assets: [asset]
        };
        vi.mocked(undici.request).mockRejectedValueOnce(new Error("network error"));

        const result = await proxyRequestServer(asset, release);

        expect(result.statusCode).toBe(502);
        expect(result.body).toBe("");
    });

    it("returns upstream error via Fastify reply during proxy download", async function () {
        const asset: types.Asset = {
            name: "app.exe",
            size: 100,
            contentType: "application/octet-stream",
            url: "http://example.com/app.exe",
            browserDownloadUrl: "http://example.com/app.exe"
        };
        const release: types.Release = {
            tag: "v1.0.0",
            name: "Release v1.0.0",
            notes: "Notes",
            publishedAt: "2024-01-01T00:00:00Z",
            prerelease: false,
            assets: [asset]
        };
        vi.mocked(undici.request).mockResolvedValueOnce({
            statusCode: 404,
            headers: {},
            body: null
        } as unknown as Awaited<ReturnType<typeof undici.request>>);

        const raw = new http.ServerResponse({ method: "GET", url: "/" } as http.IncomingMessage);
        let sendPayload: unknown;
        const reply = {
            hijack: function (): void {
                // no-op
            },
            raw: raw,
            status: function (code: number) {
                raw.statusCode = code;
                return {
                    send: function (data: unknown) {
                        sendPayload = data;
                        raw.end();
                    }
                };
            }
        };

        await service.proxyDownload("app1", asset, release, reply as unknown as import("fastify").FastifyReply);

        expect(raw.statusCode).toBe(404);
        expect(sendPayload).toEqual({
            error: { code: "PROXY_ERROR", message: "Upstream download returned status 404" }
        });
    });

    it("returns 502 via Fastify reply when proxy download fetch fails", async function () {
        const asset: types.Asset = {
            name: "app.exe",
            size: 100,
            contentType: "application/octet-stream",
            url: "http://example.com/app.exe",
            browserDownloadUrl: "http://example.com/app.exe"
        };
        const release: types.Release = {
            tag: "v1.0.0",
            name: "Release v1.0.0",
            notes: "Notes",
            publishedAt: "2024-01-01T00:00:00Z",
            prerelease: false,
            assets: [asset]
        };
        vi.mocked(undici.request).mockRejectedValueOnce(new Error("network error"));

        const raw = new http.ServerResponse({ method: "GET", url: "/" } as http.IncomingMessage);
        let sendPayload: unknown;
        const reply = {
            hijack: function (): void {
                // no-op
            },
            raw: raw,
            status: function (code: number) {
                raw.statusCode = code;
                return {
                    send: function (data: unknown) {
                        sendPayload = data;
                        raw.end();
                    }
                };
            }
        };

        await service.proxyDownload("app1", asset, release, reply as unknown as import("fastify").FastifyReply);

        expect(raw.statusCode).toBe(502);
        expect(sendPayload).toEqual({ error: { code: "PROXY_ERROR", message: "network error" } });
    });

    it("follows redirect during proxy download", async function () {
        const data = Buffer.from("redirected proxied content");
        const asset: types.Asset = {
            name: "app.exe",
            size: 100,
            contentType: "application/octet-stream",
            url: "http://example.com/app.exe",
            browserDownloadUrl: "http://example.com/app.exe"
        };
        const release: types.Release = {
            tag: "v1.0.0",
            name: "Release v1.0.0",
            notes: "Notes",
            publishedAt: "2024-01-01T00:00:00Z",
            prerelease: false,
            assets: [asset]
        };
        vi.mocked(undici.request)
            .mockResolvedValueOnce({
                statusCode: 302,
                headers: { location: "http://example.com/redirected.exe" },
                body: null
            } as unknown as Awaited<ReturnType<typeof undici.request>>)
            .mockResolvedValueOnce(createProxyResponse(data, 200, { "content-length": String(data.length) }));

        const result = await proxyRequestServer(asset, release);

        expect(result.statusCode).toBe(200);
        expect(result.body).toBe("redirected proxied content");
    });

    it("handles array redirect location during proxy download", async function () {
        const data = Buffer.from("array redirect content");
        const asset: types.Asset = {
            name: "app.exe",
            size: 100,
            contentType: "application/octet-stream",
            url: "http://example.com/app.exe",
            browserDownloadUrl: "http://example.com/app.exe"
        };
        const release: types.Release = {
            tag: "v1.0.0",
            name: "Release v1.0.0",
            notes: "Notes",
            publishedAt: "2024-01-01T00:00:00Z",
            prerelease: false,
            assets: [asset]
        };
        vi.mocked(undici.request)
            .mockResolvedValueOnce({
                statusCode: 301,
                headers: { location: ["http://example.com/redirected.exe"] },
                body: null
            } as unknown as Awaited<ReturnType<typeof undici.request>>)
            .mockResolvedValueOnce(createProxyResponse(data, 200, { "content-length": String(data.length) }));

        const result = await proxyRequestServer(asset, release);

        expect(result.statusCode).toBe(200);
        expect(result.body).toBe("array redirect content");
    });

    it("returns 502 when proxy redirect limit is exceeded", async function () {
        const asset: types.Asset = {
            name: "app.exe",
            size: 100,
            contentType: "application/octet-stream",
            url: "http://example.com/app.exe",
            browserDownloadUrl: "http://example.com/app.exe"
        };
        const release: types.Release = {
            tag: "v1.0.0",
            name: "Release v1.0.0",
            notes: "Notes",
            publishedAt: "2024-01-01T00:00:00Z",
            prerelease: false,
            assets: [asset]
        };
        vi.mocked(undici.request).mockResolvedValue({
            statusCode: 302,
            headers: { location: "http://example.com/redirect.exe" },
            body: null
        } as unknown as Awaited<ReturnType<typeof undici.request>>);

        const result = await proxyRequestServer(asset, release);

        expect(result.statusCode).toBe(502);
        expect(result.body).toBe("");
    });

    it("proxies asset through Fastify reply", async function () {
        const data = Buffer.from("fastify proxy body");
        const asset: types.Asset = {
            name: "app.exe",
            size: 100,
            contentType: "application/octet-stream",
            url: "http://example.com/app.exe",
            browserDownloadUrl: "http://example.com/app.exe"
        };
        const release: types.Release = {
            tag: "v1.0.0",
            name: "Release v1.0.0",
            notes: "Notes",
            publishedAt: "2024-01-01T00:00:00Z",
            prerelease: false,
            assets: [asset]
        };
        vi.mocked(undici.request).mockResolvedValueOnce(
            createProxyResponse(data, 200, { "content-length": String(data.length) })
        );

        const raw = new http.ServerResponse({ method: "GET", url: "/" } as http.IncomingMessage);
        let hijacked = false;
        const reply = {
            hijack: function (): void {
                hijacked = true;
            },
            raw: raw,
            status: function (code: number) {
                raw.statusCode = code;
                return {
                    send: function (_data: unknown) {
                        raw.end();
                    }
                };
            }
        };

        await service.proxyDownload("app1", asset, release, reply as unknown as import("fastify").FastifyReply);

        expect(raw.statusCode).toBe(200);
        expect(hijacked).toBe(true);
    });

    it("returns 502 when upstream proxy response has no body", async function () {
        const asset: types.Asset = {
            name: "app.exe",
            size: 100,
            contentType: "application/octet-stream",
            url: "http://example.com/app.exe",
            browserDownloadUrl: "http://example.com/app.exe"
        };
        const release: types.Release = {
            tag: "v1.0.0",
            name: "Release v1.0.0",
            notes: "Notes",
            publishedAt: "2024-01-01T00:00:00Z",
            prerelease: false,
            assets: [asset]
        };
        vi.mocked(undici.request).mockResolvedValueOnce({
            statusCode: 200,
            headers: {},
            body: null
        } as unknown as Awaited<ReturnType<typeof undici.request>>);

        const raw = new http.ServerResponse({ method: "GET", url: "/" } as http.IncomingMessage);
        let sendPayload: unknown;
        const reply = {
            hijack: function (): void {
                // no-op
            },
            raw: raw,
            status: function (code: number) {
                raw.statusCode = code;
                return {
                    send: function (data: unknown) {
                        sendPayload = data;
                    }
                };
            }
        };

        await service.proxyDownload("app1", asset, release, reply as unknown as import("fastify").FastifyReply);

        expect(raw.statusCode).toBe(502);
        expect(sendPayload).toEqual({
            error: { code: "PROXY_ERROR", message: "Upstream download returned status 502" }
        });
    });

    it("handles body stream error during proxy download", async function () {
        const asset: types.Asset = {
            name: "app.exe",
            size: 100,
            contentType: "application/octet-stream",
            url: "http://example.com/app.exe",
            browserDownloadUrl: "http://example.com/app.exe"
        };
        const release: types.Release = {
            tag: "v1.0.0",
            name: "Release v1.0.0",
            notes: "Notes",
            publishedAt: "2024-01-01T00:00:00Z",
            prerelease: false,
            assets: [asset]
        };
        const readable = new stream.Readable({
            read: function () {
                this.push("data");
                this.destroy(new Error("stream error"));
            }
        });
        vi.mocked(undici.request).mockResolvedValueOnce({
            statusCode: 200,
            headers: { "content-length": "4" },
            body: readable
        } as unknown as Awaited<ReturnType<typeof undici.request>>);

        const raw = new http.ServerResponse({ method: "GET", url: "/" } as http.IncomingMessage);
        const destroySpy = vi.spyOn(raw, "destroy");
        const reply = {
            hijack: function (): void {
                // no-op
            },
            raw: raw,
            status: function (code: number) {
                raw.statusCode = code;
                return {
                    send: function (_data: unknown) {
                        // no-op
                    }
                };
            }
        };

        await service.proxyDownload("app1", asset, release, reply as unknown as import("fastify").FastifyReply);
        await new Promise(function (resolve) {
            setTimeout(resolve, 50);
        });

        expect(destroySpy).toHaveBeenCalled();
    });

    it("aborts proxy download when timeout fires", async function () {
        const asset: types.Asset = {
            name: "app.exe",
            size: 100,
            contentType: "application/octet-stream",
            url: "http://example.com/app.exe",
            browserDownloadUrl: "http://example.com/app.exe"
        };
        const release: types.Release = {
            tag: "v1.0.0",
            name: "Release v1.0.0",
            notes: "Notes",
            publishedAt: "2024-01-01T00:00:00Z",
            prerelease: false,
            assets: [asset]
        };
        vi.useFakeTimers();
        vi.mocked(undici.request).mockImplementationOnce(function (_url, options) {
            return new Promise(function (_resolve, reject) {
                options.signal.addEventListener("abort", function () {
                    reject(new Error("aborted"));
                });
            });
        });

        const raw = new http.ServerResponse({ method: "GET", url: "/" } as http.IncomingMessage);
        const promise = service.proxyDownload("app1", asset, release, raw);
        vi.advanceTimersByTime(300000);
        await promise;

        expect(raw.statusCode).toBe(502);
        vi.useRealTimers();
    });

    it("defaults maxCacheableSize when limits omit it", async function () {
        const release = createRelease("v1.0.0");
        releaseSvc.addRelease(release);
        const filePath = path.join(tempDir, "app-windows.exe");
        fs.writeFileSync(filePath, "binary");
        assetCacheSvc.register("app1", "v1.0.0", "app-windows.exe", filePath);
        const customService = new downloadService.DownloadService(
            releaseSvc as unknown as releaseService.ReleaseService,
            assetCacheSvc,
            new platform.DefaultPlatformDetector(),
            new metrics.MetricsService(),
            new SilentLogger(),
            "http://localhost:3000",
            { maxSize: 1000, maxCount: 10, maxAgeMs: 1000 }
        );

        const result = await customService.resolveAsset("app1", { platformHint: "windows" });

        expect(result.proxied).toBe(false);
        expect(result.filePath).toBe(filePath);
    });

    it("falls back to file extension content type when proxying asset with empty content type", async function () {
        const data = Buffer.from("proxied content");
        const asset: types.Asset = {
            name: "app.exe",
            size: 100,
            contentType: "",
            url: "http://example.com/app.exe",
            browserDownloadUrl: "http://example.com/app.exe"
        };
        const release: types.Release = {
            tag: "v1.0.0",
            name: "Release v1.0.0",
            notes: "Notes",
            publishedAt: "2024-01-01T00:00:00Z",
            prerelease: false,
            assets: [asset]
        };
        vi.mocked(undici.request).mockResolvedValueOnce(
            createProxyResponse(data, 200, { "content-length": String(data.length) })
        );

        const result = await proxyRequestServer(asset, release);

        expect(result.statusCode).toBe(200);
        expect(result.headers["content-type"]).toBe("application/vnd.microsoft.portable-executable");
    });

    it("does not destroy response when body stream errors after response ended", async function () {
        const asset: types.Asset = {
            name: "app.exe",
            size: 100,
            contentType: "application/octet-stream",
            url: "http://example.com/app.exe",
            browserDownloadUrl: "http://example.com/app.exe"
        };
        const release: types.Release = {
            tag: "v1.0.0",
            name: "Release v1.0.0",
            notes: "Notes",
            publishedAt: "2024-01-01T00:00:00Z",
            prerelease: false,
            assets: [asset]
        };
        const readable = new stream.Readable({
            read: function () {
                this.push("data");
                this.push(null);
            }
        });
        readable.on("end", function () {
            setTimeout(function () {
                readable.emit("error", new Error("late error"));
            }, 20);
        });
        vi.mocked(undici.request).mockResolvedValueOnce({
            statusCode: 200,
            headers: {},
            body: readable
        } as unknown as Awaited<ReturnType<typeof undici.request>>);

        const result = await new Promise<{ statusCode: number; writableEnded: boolean }>(function (resolve) {
            let serverRes: http.ServerResponse | undefined;
            const server = http.createServer(function (_req, res) {
                serverRes = res;
                service.proxyDownload("app1", asset, release, res).catch(function () {
                    // ignore
                });
            });
            server.listen(0, function () {
                const address = server.address();
                const port = typeof address === "object" && address !== null ? address.port : 0;
                http.get({ port: port, path: "/" }, function (clientRes) {
                    let body = "";
                    clientRes.on("data", function (chunk) {
                        body = body + chunk;
                    });
                    clientRes.on("end", function () {
                        setTimeout(function () {
                            resolve({
                                statusCode: clientRes.statusCode || 0,
                                writableEnded: serverRes !== undefined ? serverRes.writableEnded : false
                            });
                            server.close();
                        }, 100);
                    });
                });
            });
        });

        expect(result.statusCode).toBe(200);
        expect(result.writableEnded).toBe(true);
    });

    it("returns 502 via Fastify reply when proxy download fetch rejects with non-error", async function () {
        const asset: types.Asset = {
            name: "app.exe",
            size: 100,
            contentType: "application/octet-stream",
            url: "http://example.com/app.exe",
            browserDownloadUrl: "http://example.com/app.exe"
        };
        const release: types.Release = {
            tag: "v1.0.0",
            name: "Release v1.0.0",
            notes: "Notes",
            publishedAt: "2024-01-01T00:00:00Z",
            prerelease: false,
            assets: [asset]
        };
        vi.mocked(undici.request).mockRejectedValueOnce("string failure");

        const raw = new http.ServerResponse({ method: "GET", url: "/" } as http.IncomingMessage);
        let sendPayload: unknown;
        const reply = {
            hijack: function (): void {
                // no-op
            },
            raw: raw,
            status: function (code: number) {
                raw.statusCode = code;
                return {
                    send: function (data: unknown) {
                        sendPayload = data;
                    }
                };
            }
        };

        await service.proxyDownload("app1", asset, release, reply as unknown as import("fastify").FastifyReply);

        expect(raw.statusCode).toBe(502);
        expect(sendPayload).toEqual({ error: { code: "PROXY_ERROR", message: "string failure" } });
    });
});
