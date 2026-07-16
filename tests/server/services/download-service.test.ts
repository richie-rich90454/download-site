import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as http from "node:http";
import * as os from "node:os";
import * as path from "node:path";
import * as types from "../../../src/shared/types.js";
import * as metrics from "../../../src/server/telemetry/metrics.js";
import * as downloadService from "../../../src/server/services/download-service.js";
import * as releaseService from "../../../src/server/services/release-service.js";
import * as assetCache from "../../../src/server/cache/asset-cache.js";
import * as platform from "../../../src/server/platform/platform-detector.js";
import { SilentLogger } from "../test-helpers.js";

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
});
