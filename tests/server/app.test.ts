import * as vitest from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as http from "node:http";
import * as crypto from "node:crypto";
import type { Services } from "../../src/server/container.js";
import * as appFactory from "../../src/server/app.js";
import * as config from "../../src/server/config/config.js";
import * as metrics from "../../src/server/telemetry/metrics.js";
import * as tracing from "../../src/server/telemetry/tracing.js";
import * as platform from "../../src/server/platform/platform-detector.js";
import * as releaseService from "../../src/server/services/release-service.js";
import * as downloadService from "../../src/server/services/download-service.js";
import * as updaterTypes from "../../src/server/services/updaters/updater-types.js";
import * as tauriUpdater from "../../src/server/services/updaters/tauri-updater-service.js";
import * as genericUpdater from "../../src/server/services/updaters/generic-updater-service.js";
import * as squirrelUpdater from "../../src/server/services/updaters/squirrel-updater-service.js";
import * as sparkleUpdater from "../../src/server/services/updaters/sparkle-updater-service.js";
import * as health from "../../src/server/health/health-service.js";
import * as metadataCache from "../../src/server/cache/metadata-cache.js";
import * as assetCache from "../../src/server/cache/asset-cache.js";
import * as types from "../../src/shared/types.js";
import * as githubTypes from "../../src/server/github/github-types.js";
import { SilentLogger } from "./test-helpers.js";

function createTestConfig(): config.ServerConfig {
    return {
        port: 3000,
        cacheDir: path.join(os.tmpdir(), "download-server-test-" + Date.now()),
        logLevel: "silent",
        corsOrigin: "*",
        github: { token: undefined, appId: undefined, privateKey: undefined },
        rateLimits: { max: 1000, timeWindow: 60000 },
        apps: [
            { id: "app1", repo: "owner/app1", name: "App One" },
            { id: "app2", repo: "owner/app2", name: "App Two" }
        ]
    };
}

class MockHealthService implements health.HealthService {
    private initialized = false;

    isReady(): boolean {
        return this.initialized;
    }

    isLive(): boolean {
        return true;
    }

    getHealth(): health.HealthStatus {
        const ready = this.initialized;
        return {
            status: ready ? "healthy" : "unhealthy",
            ready: ready,
            live: true,
            uptime: 0,
            checks: {
                cacheInitialized: this.initialized,
                diskSpace: { ok: true, freeBytes: 1000000000, thresholdBytes: 100000000 }
            }
        };
    }

    markCacheInitialized(initialized: boolean): void {
        this.initialized = initialized;
    }
}

class MockMetadataCache implements metadataCache.MetadataCacheService {
    invalidatedApps: string[] = [];
    invalidatedTags: Array<{ app: string; tag: string }> = [];
    invalidatedAll = false;

    getReleases(): metadataCache.ReleasesCacheEntry | undefined {
        return undefined;
    }

    getReleaseByTag(): metadataCache.ReleaseCacheEntry | undefined {
        return undefined;
    }

    setReleases(): void {
        // no-op
    }

    setRelease(): void {
        // no-op
    }

    invalidateApp(app: string): void {
        this.invalidatedApps.push(app);
    }

    invalidateTag(app: string, tag: string): void {
        this.invalidatedTags.push({ app: app, tag: tag });
    }

    invalidateAll(): void {
        this.invalidatedAll = true;
    }

    close(): void {
        // no-op
    }
}

class MockAssetCache implements assetCache.AssetCacheService {
    purgeCalls: Array<{ app?: string; version?: string; assetName?: string }> = [];

    async getAssetPath(): Promise<assetCache.AssetCacheResult> {
        return {
            filePath: "/cache/asset.exe",
            cached: false,
            entry: {
                app: "app1",
                version: "v1.0.0",
                assetName: "app-windows.exe",
                filePath: "/cache/asset.exe",
                size: 100,
                checksum: "abc",
                lastAccessedAt: Date.now(),
                createdAt: Date.now()
            }
        };
    }

    getChecksum(): string | undefined {
        return undefined;
    }

    purge(app?: string, version?: string, assetName?: string): void {
        this.purgeCalls.push({ app: app, version: version, assetName: assetName });
    }

    close(): void {
        // no-op
    }
}

class MockReleaseService {
    private releases: types.Release[] = [];
    private throwOnList = false;
    warmCacheCalled = false;

    setReleases(releases: types.Release[]): void {
        this.releases = releases;
    }

    setThrowOnList(throwOnList: boolean): void {
        this.throwOnList = throwOnList;
    }

    async listReleases(): Promise<types.Release[]> {
        if (this.throwOnList) {
            throw new Error("release service failure");
        }
        return this.releases;
    }

    async getLatestRelease(): Promise<types.Release | undefined> {
        if (this.releases.length === 0) {
            return undefined;
        }
        return this.releases[0];
    }

    async getReleaseByTag(appId: string, tag: string): Promise<types.Release | undefined> {
        for (let i = 0; i < this.releases.length; i = i + 1) {
            if (this.releases[i].tag === tag) {
                return this.releases[i];
            }
        }
        return undefined;
    }

    async warmCache(): Promise<void> {
        this.warmCacheCalled = true;
    }

    async refreshReleases(): Promise<types.Release[]> {
        return this.releases;
    }

    async refreshReleaseByTag(_appId: string, tag: string): Promise<types.Release | undefined> {
        return this.getReleaseByTag(_appId, tag);
    }
}

class MockDownloadService {
    private files: Record<string, string> = {};

    registerFile(app: string, version: string, assetName: string, filePath: string): void {
        this.files[app + "/" + version + "/" + assetName] = filePath;
    }

    async resolveAsset(
        appId: string,
        options: downloadService.DownloadOptions
    ): Promise<downloadService.DownloadResult> {
        const version = options.version !== undefined && options.version.length > 0 ? options.version : "v1.0.0";
        const assetName =
            options.assetName !== undefined && options.assetName.length > 0 ? options.assetName : "app-windows.exe";
        const filePath = this.files[appId + "/" + version + "/" + assetName];
        if (filePath === undefined) {
            throw new Error("Asset not found");
        }
        const release: types.Release = {
            tag: version,
            name: "Release " + version,
            notes: "Notes",
            publishedAt: "2024-01-01T00:00:00Z",
            prerelease: false,
            assets: []
        };
        const asset: types.Asset = {
            name: assetName,
            size: 100,
            contentType: "application/octet-stream",
            url: "http://example.com/" + assetName,
            browserDownloadUrl: "http://example.com/" + assetName
        };
        return { filePath: filePath, asset: asset, release: release };
    }

    serveFile(
        filePath: string,
        assetName: string,
        reply: http.ServerResponse | { raw: http.ServerResponse },
        rangeHeader?: string
    ): void {
        const content = fs.readFileSync(filePath);
        const totalSize = content.length;
        let start = 0;
        let end = totalSize - 1;
        let status = 200;
        if (rangeHeader !== undefined && rangeHeader.indexOf("bytes=") === 0) {
            const rangeValue = rangeHeader.substring(6);
            const dashIndex = rangeValue.indexOf("-");
            if (dashIndex >= 0) {
                const startStr = rangeValue.substring(0, dashIndex);
                const endStr = rangeValue.substring(dashIndex + 1);
                start = startStr.length > 0 ? Number(startStr) : 0;
                end = endStr.length > 0 ? Number(endStr) : totalSize - 1;
                status = 206;
            }
        }
        const slice = content.subarray(start, end + 1);
        const res = "raw" in reply ? reply.raw : reply;
        res.statusCode = status;
        res.setHeader("Content-Type", "application/octet-stream");
        res.setHeader("Content-Disposition", 'attachment; filename="' + assetName + '"');
        if (status === 206) {
            res.setHeader("Content-Range", "bytes " + start + "-" + end + "/" + totalSize);
        }
        res.end(slice);
    }

    buildAssetUrl(appId: string, version: string, assetName: string): string {
        return "http://localhost:3000/download/" + appId + "?version=" + version + "&asset=" + assetName;
    }
}

class MockTauriUpdaterService {
    result: updaterTypes.UpdaterResult = { status: 204, body: undefined };

    async getV1Update(): Promise<updaterTypes.UpdaterResult> {
        return this.result;
    }

    async getV2Update(): Promise<updaterTypes.UpdaterResult> {
        return this.result;
    }
}

class MockGenericUpdaterService {
    result: updaterTypes.UpdaterResult = { status: 204, body: undefined };

    async getUpdate(): Promise<updaterTypes.UpdaterResult> {
        return this.result;
    }
}

class MockSquirrelUpdaterService {
    result: updaterTypes.UpdaterResult = { status: 204, body: undefined };

    async getUpdate(): Promise<updaterTypes.UpdaterResult> {
        return this.result;
    }
}

class MockSparkleUpdaterService {
    result: updaterTypes.UpdaterResult = { status: 204, body: undefined };

    async getAppcast(): Promise<updaterTypes.UpdaterResult> {
        return this.result;
    }
}

function createRelease(tag: string): types.Release {
    return {
        tag: tag,
        name: "Release " + tag,
        notes: "Notes for " + tag,
        publishedAt: "2024-01-15T00:00:00Z",
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
                size: 120,
                contentType: "application/x-apple-diskimage",
                url: "http://example.com/app-macos.dmg",
                browserDownloadUrl: "http://example.com/app-macos.dmg"
            }
        ]
    };
}

function buildTestServices(): Services {
    const cfg = createTestConfig();
    const releaseSvc = new MockReleaseService();
    const downloadSvc = new MockDownloadService();
    const tauriSvc = new MockTauriUpdaterService();
    const genericSvc = new MockGenericUpdaterService();
    const squirrelSvc = new MockSquirrelUpdaterService();
    const sparkleSvc = new MockSparkleUpdaterService();
    const healthSvc = new MockHealthService();
    const metadataCacheSvc = new MockMetadataCache();
    const assetCacheSvc = new MockAssetCache();

    return {
        config: cfg,
        logger: new SilentLogger(),
        metrics: new metrics.MetricsService(),
        telemetry: new tracing.TelemetryService(),
        health: healthSvc,
        githubProvider: {} as githubTypes.GitHubProvider,
        metadataCache: metadataCacheSvc,
        assetCache: assetCacheSvc,
        platformDetector: new platform.DefaultPlatformDetector(),
        release: releaseSvc as unknown as releaseService.ReleaseService,
        download: downloadSvc as unknown as downloadService.DownloadService,
        tauriUpdater: tauriSvc as unknown as tauriUpdater.TauriUpdaterService,
        genericUpdater: genericSvc as unknown as genericUpdater.GenericUpdaterService,
        squirrelUpdater: squirrelSvc as unknown as squirrelUpdater.SquirrelUpdaterService,
        sparkleUpdater: sparkleSvc as unknown as sparkleUpdater.SparkleUpdaterService
    };
}

vitest.describe("buildApp", function () {
    let services: Services;
    let tempDir: string;
    const originalAdminKey = process.env.ADMIN_API_KEY;
    const originalWebhookSecret = process.env.WEBHOOK_SECRET;

    vitest.beforeEach(function () {
        delete process.env.ADMIN_API_KEY;
        delete process.env.WEBHOOK_SECRET;
        services = buildTestServices();
        tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "download-server-app-"));
    });

    vitest.afterEach(async function () {
        fs.rmSync(tempDir, { recursive: true, force: true });
        if (originalAdminKey !== undefined) {
            process.env.ADMIN_API_KEY = originalAdminKey;
        } else {
            delete process.env.ADMIN_API_KEY;
        }
        if (originalWebhookSecret !== undefined) {
            process.env.WEBHOOK_SECRET = originalWebhookSecret;
        } else {
            delete process.env.WEBHOOK_SECRET;
        }
    });

    vitest.it("registers health routes", async function () {
        const app = await appFactory.buildApp(services);

        const response = await app.inject({ method: "GET", url: "/health" });

        vitest.expect(response.statusCode).toBe(200);
        const body = JSON.parse(response.payload);
        vitest.expect(body.status).toBe("unhealthy");
    });

    vitest.it("returns 503 when not ready", async function () {
        const app = await appFactory.buildApp(services);

        const response = await app.inject({ method: "GET", url: "/health/ready" });

        vitest.expect(response.statusCode).toBe(503);
    });

    vitest.it("returns 200 when ready", async function () {
        services.health.markCacheInitialized(true);
        const app = await appFactory.buildApp(services);

        const response = await app.inject({ method: "GET", url: "/health/ready" });

        vitest.expect(response.statusCode).toBe(200);
    });

    vitest.it("lists configured apps", async function () {
        const app = await appFactory.buildApp(services);

        const response = await app.inject({ method: "GET", url: "/api/apps" });

        vitest.expect(response.statusCode).toBe(200);
        const body = JSON.parse(response.payload);
        vitest.expect(body.apps.length).toBe(2);
        vitest.expect(body.apps[0].id).toBe("app1");
        vitest.expect(body.apps[0].name).toBe("App One");
    });

    vitest.it("lists releases", async function () {
        const release = createRelease("v1.0.0");
        const mockRelease = services.release as unknown as MockReleaseService;
        mockRelease.setReleases([release]);
        const app = await appFactory.buildApp(services);

        const response = await app.inject({ method: "GET", url: "/api/releases/app1" });

        vitest.expect(response.statusCode).toBe(200);
        const body = JSON.parse(response.payload);
        vitest.expect(body.app).toBe("app1");
        vitest.expect(body.releases.length).toBe(1);
        vitest.expect(body.releases[0].tag).toBe("v1.0.0");
    });

    vitest.it("returns default update metadata", async function () {
        const release = createRelease("v1.0.0");
        const mockRelease = services.release as unknown as MockReleaseService;
        mockRelease.setReleases([release]);
        const app = await appFactory.buildApp(services);

        const response = await app.inject({ method: "GET", url: "/api/update/app1" });

        vitest.expect(response.statusCode).toBe(200);
        const body = JSON.parse(response.payload);
        vitest.expect(body.version).toBe("v1.0.0");
        vitest.expect(body.assets.length).toBe(2);
    });

    vitest.it("returns 204 for tauri updater when up to date", async function () {
        const mockTauri = services.tauriUpdater as unknown as MockTauriUpdaterService;
        mockTauri.result = { status: 204, body: undefined };
        const app = await appFactory.buildApp(services);

        const response = await app.inject({
            method: "GET",
            url: "/api/update/tauri/app1?target=windows-x64&current_version=v1.0.0"
        });

        vitest.expect(response.statusCode).toBe(204);
    });

    vitest.it("returns tauri manifest when update available", async function () {
        const mockTauri = services.tauriUpdater as unknown as MockTauriUpdaterService;
        mockTauri.result = {
            status: 200,
            body: {
                version: "1.0.0",
                notes: "Notes",
                pub_date: "2024-01-01T00:00:00Z",
                signature: "sig",
                url: "http://localhost:3000/download/app1?version=v1.0.0&asset=app-windows.exe"
            }
        };
        const app = await appFactory.buildApp(services);

        const response = await app.inject({ method: "GET", url: "/api/update/tauri/app1?target=windows-x64" });

        vitest.expect(response.statusCode).toBe(200);
        const body = JSON.parse(response.payload);
        vitest.expect(body.version).toBe("1.0.0");
    });

    vitest.it("returns tauri v2 manifest", async function () {
        const mockTauri = services.tauriUpdater as unknown as MockTauriUpdaterService;
        mockTauri.result = {
            status: 200,
            body: {
                version: "1.0.0",
                notes: "Notes",
                pub_date: "2024-01-01T00:00:00Z",
                platforms: {
                    windows_x64: { signature: "sig", url: "http://example.com" }
                }
            }
        };
        const app = await appFactory.buildApp(services);

        const response = await app.inject({ method: "GET", url: "/api/update/tauri-v2/app1" });

        vitest.expect(response.statusCode).toBe(200);
        const body = JSON.parse(response.payload);
        vitest.expect(body.platforms.windows_x64.signature).toBe("sig");
    });

    vitest.it("returns 404 when update release not found", async function () {
        const mockRelease = services.release as unknown as MockReleaseService;
        mockRelease.setReleases([]);
        const app = await appFactory.buildApp(services);

        const response = await app.inject({ method: "GET", url: "/api/update/app1" });

        vitest.expect(response.statusCode).toBe(404);
    });

    vitest.it("returns update metadata for a specific version", async function () {
        const release = createRelease("v2.0.0");
        const mockRelease = services.release as unknown as MockReleaseService;
        mockRelease.setReleases([release]);
        const app = await appFactory.buildApp(services);

        const response = await app.inject({ method: "GET", url: "/api/update/app1?version=v2.0.0" });

        vitest.expect(response.statusCode).toBe(200);
        const body = JSON.parse(response.payload);
        vitest.expect(body.version).toBe("v2.0.0");
        vitest.expect(body.assets.length).toBe(2);
    });

    vitest.it("returns updater error status", async function () {
        const mockTauri = services.tauriUpdater as unknown as MockTauriUpdaterService;
        mockTauri.result = { status: 400, body: { error: "bad request" } };
        const app = await appFactory.buildApp(services);

        const response = await app.inject({ method: "GET", url: "/api/update/tauri/app1?target=windows-x64" });

        vitest.expect(response.statusCode).toBe(400);
    });

    vitest.it("returns generic update manifest", async function () {
        const mockGeneric = services.genericUpdater as unknown as MockGenericUpdaterService;
        mockGeneric.result = {
            status: 200,
            body: {
                version: "1.0.0",
                notes: "Notes",
                pubDate: "2024-01-01T00:00:00Z",
                platforms: {
                    windows_x64: { signature: "sig", url: "http://example.com" }
                }
            }
        };
        const app = await appFactory.buildApp(services);

        const response = await app.inject({ method: "GET", url: "/api/update/generic/app1" });

        vitest.expect(response.statusCode).toBe(200);
        const body = JSON.parse(response.payload);
        vitest.expect(body.platforms.windows_x64.signature).toBe("sig");
    });

    vitest.it("returns squirrel manifest", async function () {
        const mockSquirrel = services.squirrelUpdater as unknown as MockSquirrelUpdaterService;
        mockSquirrel.result = {
            status: 200,
            body: {
                url: "http://example.com/setup.exe",
                name: "Release 1.0.0",
                notes: "Notes",
                pub_date: "2024-01-01T00:00:00Z"
            }
        };
        const app = await appFactory.buildApp(services);

        const response = await app.inject({ method: "GET", url: "/api/update/squirrel/app1" });

        vitest.expect(response.statusCode).toBe(200);
        const body = JSON.parse(response.payload);
        vitest.expect(body.url).toBe("http://example.com/setup.exe");
    });

    vitest.it("returns sparkle appcast", async function () {
        const mockSparkle = services.sparkleUpdater as unknown as MockSparkleUpdaterService;
        mockSparkle.result = {
            status: 200,
            body: '<?xml version="1.0"?><rss></rss>',
            contentType: "application/xml"
        };
        const app = await appFactory.buildApp(services);

        const response = await app.inject({ method: "GET", url: "/api/update/sparkle/app1" });

        vitest.expect(response.statusCode).toBe(200);
        vitest.expect(response.headers["content-type"]).toBe("application/xml");
        vitest.expect(response.payload).toContain("<rss>");
    });

    vitest.it("passes current_version to tauri v2 updater", async function () {
        const mockTauri = services.tauriUpdater as unknown as MockTauriUpdaterService;
        mockTauri.result = {
            status: 200,
            body: {
                version: "1.0.0",
                notes: "Notes",
                pub_date: "2024-01-01T00:00:00Z",
                platforms: {}
            }
        };
        const app = await appFactory.buildApp(services);

        const response = await app.inject({
            method: "GET",
            url: "/api/update/tauri-v2/app1?current_version=v1.0.0"
        });

        vitest.expect(response.statusCode).toBe(200);
    });

    vitest.it("passes current_version to generic updater", async function () {
        const mockGeneric = services.genericUpdater as unknown as MockGenericUpdaterService;
        mockGeneric.result = {
            status: 200,
            body: {
                version: "1.0.0",
                notes: "Notes",
                pubDate: "2024-01-01T00:00:00Z",
                platforms: {}
            }
        };
        const app = await appFactory.buildApp(services);

        const response = await app.inject({
            method: "GET",
            url: "/api/update/generic/app1?current_version=v1.0.0"
        });

        vitest.expect(response.statusCode).toBe(200);
    });

    vitest.it("passes current_version to squirrel updater", async function () {
        const mockSquirrel = services.squirrelUpdater as unknown as MockSquirrelUpdaterService;
        mockSquirrel.result = {
            status: 200,
            body: {
                url: "http://example.com/setup.exe",
                name: "Release 1.0.0",
                notes: "Notes",
                pub_date: "2024-01-01T00:00:00Z"
            }
        };
        const app = await appFactory.buildApp(services);

        const response = await app.inject({
            method: "GET",
            url: "/api/update/squirrel/app1?current_version=v1.0.0"
        });

        vitest.expect(response.statusCode).toBe(200);
    });

    vitest.it("passes current_version to sparkle updater without content type", async function () {
        const mockSparkle = services.sparkleUpdater as unknown as MockSparkleUpdaterService;
        mockSparkle.result = {
            status: 200,
            body: '<?xml version="1.0"?><rss></rss>'
        };
        const app = await appFactory.buildApp(services);

        const response = await app.inject({
            method: "GET",
            url: "/api/update/sparkle/app1?current_version=v1.0.0"
        });

        vitest.expect(response.statusCode).toBe(200);
        vitest.expect(response.payload).toContain("<rss>");
    });

    vitest.it("downloads asset", async function () {
        const filePath = path.join(tempDir, "app-windows.exe");
        fs.writeFileSync(filePath, "binary-payload");
        const mockDownload = services.download as unknown as MockDownloadService;
        mockDownload.registerFile("app1", "v1.0.0", "app-windows.exe", filePath);
        const app = await appFactory.buildApp(services);

        const response = await app.inject({
            method: "GET",
            url: "/download/app1?version=v1.0.0&asset=app-windows.exe"
        });

        vitest.expect(response.statusCode).toBe(200);
        vitest.expect(response.payload).toBe("binary-payload");
        vitest.expect(response.headers["content-disposition"]).toBe('attachment; filename="app-windows.exe"');
    });

    vitest.it("supports range requests for downloads", async function () {
        const filePath = path.join(tempDir, "app-windows.exe");
        fs.writeFileSync(filePath, "abcdef");
        const mockDownload = services.download as unknown as MockDownloadService;
        mockDownload.registerFile("app1", "v1.0.0", "app-windows.exe", filePath);
        const app = await appFactory.buildApp(services);

        const response = await app.inject({
            method: "GET",
            url: "/download/app1?version=v1.0.0&asset=app-windows.exe",
            headers: { Range: "bytes=1-3" }
        });

        vitest.expect(response.statusCode).toBe(206);
        vitest.expect(response.payload).toBe("bcd");
    });

    vitest.it("purges cache with valid admin key", async function () {
        process.env.ADMIN_API_KEY = "secret-admin-key";
        const app = await appFactory.buildApp(services);

        const response = await app.inject({
            method: "POST",
            url: "/admin/cache/purge",
            headers: { "x-admin-api-key": "secret-admin-key" },
            payload: { app: "app1" }
        });

        vitest.expect(response.statusCode).toBe(200);
        const body = JSON.parse(response.payload);
        vitest.expect(body.success).toBe(true);
        const metadataCacheMock = services.metadataCache as unknown as MockMetadataCache;
        vitest.expect(metadataCacheMock.invalidatedApps).toContain("app1");
        delete process.env.ADMIN_API_KEY;
    });

    vitest.it("purges cache by app and version", async function () {
        process.env.ADMIN_API_KEY = "secret-admin-key";
        const app = await appFactory.buildApp(services);

        const response = await app.inject({
            method: "POST",
            url: "/admin/cache/purge",
            headers: { "x-admin-api-key": "secret-admin-key" },
            payload: { app: "app1", version: "v1.0.0" }
        });

        vitest.expect(response.statusCode).toBe(200);
        const metadataCacheMock = services.metadataCache as unknown as MockMetadataCache;
        vitest
            .expect(
                metadataCacheMock.invalidatedTags.some(function (item) {
                    return item.app === "app1" && item.tag === "v1.0.0";
                })
            )
            .toBe(true);
        delete process.env.ADMIN_API_KEY;
    });

    vitest.it("downloads a previous version by version query", async function () {
        const filePath = path.join(tempDir, "app-windows.exe");
        fs.writeFileSync(filePath, "previous-binary");
        const mockDownload = services.download as unknown as MockDownloadService;
        mockDownload.registerFile("app1", "v0.9.0", "app-windows.exe", filePath);
        const app = await appFactory.buildApp(services);

        const response = await app.inject({
            method: "GET",
            url: "/download/app1?version=v0.9.0&asset=app-windows.exe"
        });

        vitest.expect(response.statusCode).toBe(200);
        vitest.expect(response.payload).toBe("previous-binary");
    });

    vitest.it("refreshes metadata cache for an app", async function () {
        process.env.ADMIN_API_KEY = "secret-admin-key";
        const release = createRelease("v1.0.0");
        const mockRelease = services.release as unknown as MockReleaseService;
        mockRelease.setReleases([release]);
        const app = await appFactory.buildApp(services);

        const response = await app.inject({
            method: "POST",
            url: "/admin/cache/refresh",
            headers: { "x-admin-api-key": "secret-admin-key" },
            payload: { app: "app1" }
        });

        vitest.expect(response.statusCode).toBe(200);
        const body = JSON.parse(response.payload);
        vitest.expect(body.success).toBe(true);
        delete process.env.ADMIN_API_KEY;
    });

    vitest.it("redownloads a cached asset", async function () {
        process.env.ADMIN_API_KEY = "secret-admin-key";
        const release = createRelease("v1.0.0");
        const mockRelease = services.release as unknown as MockReleaseService;
        mockRelease.setReleases([release]);
        const app = await appFactory.buildApp(services);

        const response = await app.inject({
            method: "POST",
            url: "/admin/assets/redownload",
            headers: { "x-admin-api-key": "secret-admin-key" },
            payload: { app: "app1", version: "v1.0.0", asset: "app-windows.exe" }
        });

        vitest.expect(response.statusCode).toBe(200);
        const body = JSON.parse(response.payload);
        vitest.expect(body.success).toBe(true);
        const assetCacheMock = services.assetCache as unknown as MockAssetCache;
        vitest
            .expect(
                assetCacheMock.purgeCalls.some(function (item) {
                    return item.app === "app1" && item.version === "v1.0.0" && item.assetName === "app-windows.exe";
                })
            )
            .toBe(true);
        delete process.env.ADMIN_API_KEY;
    });

    vitest.it("purges all caches when no scope is given", async function () {
        process.env.ADMIN_API_KEY = "secret-admin-key";
        const app = await appFactory.buildApp(services);

        const response = await app.inject({
            method: "POST",
            url: "/admin/cache/purge",
            headers: { "x-admin-api-key": "secret-admin-key" },
            payload: {}
        });

        vitest.expect(response.statusCode).toBe(200);
        const metadataCacheMock = services.metadataCache as unknown as MockMetadataCache;
        vitest.expect(metadataCacheMock.invalidatedAll).toBe(true);
        delete process.env.ADMIN_API_KEY;
    });

    vitest.it("rejects admin purge without key", async function () {
        process.env.ADMIN_API_KEY = "secret-admin-key";
        const app = await appFactory.buildApp(services);

        const response = await app.inject({
            method: "POST",
            url: "/admin/cache/purge",
            payload: {}
        });

        vitest.expect(response.statusCode).toBe(401);
        delete process.env.ADMIN_API_KEY;
    });

    vitest.it("rejects admin purge with invalid key", async function () {
        process.env.ADMIN_API_KEY = "secret-admin-key";
        const app = await appFactory.buildApp(services);

        const response = await app.inject({
            method: "POST",
            url: "/admin/cache/purge",
            headers: { "x-admin-api-key": "wrong-key" },
            payload: {}
        });

        vitest.expect(response.statusCode).toBe(401);
        delete process.env.ADMIN_API_KEY;
    });

    vitest.it("returns 403 for admin when key not configured", async function () {
        delete process.env.ADMIN_API_KEY;
        const app = await appFactory.buildApp(services);

        const response = await app.inject({
            method: "POST",
            url: "/admin/cache/purge",
            headers: { "x-admin-api-key": "any-key" },
            payload: {}
        });

        vitest.expect(response.statusCode).toBe(403);
    });

    vitest.it("accepts valid github webhook", async function () {
        process.env.WEBHOOK_SECRET = "webhook-secret";
        const app = await appFactory.buildApp(services);
        const payload = JSON.stringify({
            action: "published",
            repository: { full_name: "owner/app1" },
            release: { tag_name: "v1.0.0" }
        });
        const signature = "sha256=" + crypto.createHmac("sha256", "webhook-secret").update(payload).digest("hex");

        const response = await app.inject({
            method: "POST",
            url: "/webhooks/github/release",
            headers: {
                "x-hub-signature-256": signature,
                "content-type": "application/json"
            },
            payload: payload
        });

        vitest.expect(response.statusCode).toBe(200);
        const body = JSON.parse(response.payload);
        vitest.expect(body.success).toBe(true);
        const metadataCacheMock = services.metadataCache as unknown as MockMetadataCache;
        vitest
            .expect(
                metadataCacheMock.invalidatedTags.some(function (item) {
                    return item.app === "app1" && item.tag === "v1.0.0";
                })
            )
            .toBe(true);
        delete process.env.WEBHOOK_SECRET;
    });

    vitest.it("invalidates app cache when webhook has no release tag", async function () {
        process.env.WEBHOOK_SECRET = "webhook-secret";
        const app = await appFactory.buildApp(services);
        const payload = JSON.stringify({
            action: "published",
            repository: { full_name: "owner/app1" }
        });
        const signature = "sha256=" + crypto.createHmac("sha256", "webhook-secret").update(payload).digest("hex");

        const response = await app.inject({
            method: "POST",
            url: "/webhooks/github/release",
            headers: {
                "x-hub-signature-256": signature,
                "content-type": "application/json"
            },
            payload: payload
        });

        vitest.expect(response.statusCode).toBe(200);
        const body = JSON.parse(response.payload);
        vitest.expect(body.success).toBe(true);
        const metadataCacheMock = services.metadataCache as unknown as MockMetadataCache;
        vitest.expect(metadataCacheMock.invalidatedApps).toContain("app1");
        delete process.env.WEBHOOK_SECRET;
    });

    vitest.it("accepts github webhook without repository", async function () {
        process.env.WEBHOOK_SECRET = "webhook-secret";
        const app = await appFactory.buildApp(services);
        const payload = JSON.stringify({ action: "published" });
        const signature = "sha256=" + crypto.createHmac("sha256", "webhook-secret").update(payload).digest("hex");

        const response = await app.inject({
            method: "POST",
            url: "/webhooks/github/release",
            headers: {
                "x-hub-signature-256": signature,
                "content-type": "application/json"
            },
            payload: payload
        });

        vitest.expect(response.statusCode).toBe(200);
        const body = JSON.parse(response.payload);
        vitest.expect(body.success).toBe(true);
        const metadataCacheMock = services.metadataCache as unknown as MockMetadataCache;
        vitest.expect(metadataCacheMock.invalidatedApps.length).toBe(0);
        delete process.env.WEBHOOK_SECRET;
    });

    vitest.it("rejects github webhook with invalid signature", async function () {
        process.env.WEBHOOK_SECRET = "webhook-secret";
        const app = await appFactory.buildApp(services);
        const payload = JSON.stringify({ action: "published" });

        const response = await app.inject({
            method: "POST",
            url: "/webhooks/github/release",
            headers: {
                "x-hub-signature-256": "sha256=invalid",
                "content-type": "application/json"
            },
            payload: payload
        });

        vitest.expect(response.statusCode).toBe(401);
        delete process.env.WEBHOOK_SECRET;
    });

    vitest.it("rejects github webhook when secret not configured", async function () {
        delete process.env.WEBHOOK_SECRET;
        const app = await appFactory.buildApp(services);

        const response = await app.inject({
            method: "POST",
            url: "/webhooks/github/release",
            headers: { "x-hub-signature-256": "sha256=anything" },
            payload: {}
        });

        vitest.expect(response.statusCode).toBe(403);
    });

    vitest.it("exposes metrics", async function () {
        const app = await appFactory.buildApp(services);

        const response = await app.inject({ method: "GET", url: "/metrics" });

        vitest.expect(response.statusCode).toBe(200);
        vitest.expect(response.payload).toContain("http_requests_total");
    });

    vitest.it("serves swagger ui", async function () {
        const app = await appFactory.buildApp(services);

        const response = await app.inject({ method: "GET", url: "/docs" });

        vitest.expect(response.statusCode).toBe(200);
        vitest.expect(response.payload).toContain("swagger");
    });

    vitest.it("serves spa fallback for unknown html routes", async function () {
        const app = await appFactory.buildApp(services);

        const response = await app.inject({ method: "GET", url: "/unknown-route", headers: { accept: "text/html" } });

        vitest.expect(response.statusCode).toBe(200);
        vitest.expect(response.payload).toContain("Application Download");
    });

    vitest.it("returns structured error for unknown api routes", async function () {
        const app = await appFactory.buildApp(services);

        const response = await app.inject({ method: "GET", url: "/api/unknown" });

        vitest.expect(response.statusCode).toBe(404);
        const body = JSON.parse(response.payload);
        vitest.expect(body.error.code).toBe("NOT_FOUND");
    });

    vitest.it("returns structured error for unknown download routes", async function () {
        const app = await appFactory.buildApp(services);

        const response = await app.inject({ method: "GET", url: "/download/unknown" });

        vitest.expect(response.statusCode).toBe(404);
        const body = JSON.parse(response.payload);
        vitest.expect(body.error.code).toBe("NOT_FOUND");
    });

    vitest.it("serves spa fallback for non-api non-download routes", async function () {
        const app = await appFactory.buildApp(services);

        const response = await app.inject({ method: "GET", url: "/some-page" });

        vitest.expect(response.statusCode).toBe(200);
        vitest.expect(response.payload).toContain("Application Download");
    });

    vitest.it("returns json 404 when spa index is missing", async function () {
        const distPublicDir = path.resolve(process.cwd(), "dist", "public");
        const publicDir = path.resolve(process.cwd(), "public");
        const distIndexPath = path.resolve(distPublicDir, "index.html");
        const publicIndexPath = path.resolve(publicDir, "index.html");
        const distBackupPath = distIndexPath + ".bak";
        const publicBackupPath = publicIndexPath + ".bak";
        const movedDist = fs.existsSync(distIndexPath);
        const movedPublic = fs.existsSync(publicIndexPath);
        if (movedDist) {
            fs.renameSync(distIndexPath, distBackupPath);
        }
        if (movedPublic) {
            fs.renameSync(publicIndexPath, publicBackupPath);
        }
        try {
            const app = await appFactory.buildApp(services);

            const response = await app.inject({
                method: "GET",
                url: "/unknown-route",
                headers: { accept: "text/html" }
            });

            vitest.expect(response.statusCode).toBe(404);
            const body = JSON.parse(response.payload);
            vitest.expect(body.error.code).toBe("NOT_FOUND");
        } finally {
            if (movedDist) {
                fs.renameSync(distBackupPath, distIndexPath);
            }
            if (movedPublic) {
                fs.renameSync(publicBackupPath, publicIndexPath);
            }
        }
    });

    vitest.it("returns structured error when service throws", async function () {
        const mockRelease = services.release as unknown as MockReleaseService;
        mockRelease.setThrowOnList(true);
        const app = await appFactory.buildApp(services);

        const response = await app.inject({ method: "GET", url: "/api/releases/app1" });

        vitest.expect(response.statusCode).toBe(500);
        const body = JSON.parse(response.payload);
        vitest.expect(body.error.code).toBe("INTERNAL_SERVER_ERROR");
    });

    vitest.it("returns validation error details for invalid query params", async function () {
        const app = await appFactory.buildApp(services);

        const response = await app.inject({ method: "GET", url: "/api/releases/app1?page=0" });

        vitest.expect(response.statusCode).toBe(400);
        const body = JSON.parse(response.payload);
        vitest.expect(body.error.code).toBe("FST_ERR_VALIDATION");
        vitest.expect(body.error.details).toBeDefined();
    });

    vitest.it("returns 404 when download asset is not found", async function () {
        const app = await appFactory.buildApp(services);

        const response = await app.inject({
            method: "GET",
            url: "/download/app1?version=v1.0.0&asset=missing.exe"
        });

        vitest.expect(response.statusCode).toBe(404);
        const body = JSON.parse(response.payload);
        vitest.expect(body.error.code).toBe("NOT_FOUND");
    });

    vitest.it("returns live status", async function () {
        const app = await appFactory.buildApp(services);

        const response = await app.inject({ method: "GET", url: "/health/live" });

        vitest.expect(response.statusCode).toBe(200);
        const body = JSON.parse(response.payload);
        vitest.expect(body.live).toBe(true);
    });
});
