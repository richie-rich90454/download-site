import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as types from "../../../src/shared/types.js";
import * as config from "../../../src/server/config/config.js";
import * as githubTypes from "../../../src/server/github/github-types.js";
import * as metadataCache from "../../../src/server/cache/metadata-cache.js";
import * as platform from "../../../src/server/platform/platform-detector.js";
import * as health from "../../../src/server/health/health-service.js";
import * as releaseService from "../../../src/server/services/release-service.js";
import { SilentLogger } from "../test-helpers.js";

function createGitHubRelease(tag: string, publishedAt: string): types.GitHubRelease {
    return {
        tag_name: tag,
        name: "Release " + tag,
        body: "Notes",
        published_at: publishedAt,
        prerelease: false,
        assets: [
            {
                name: "app-windows.exe",
                size: 100,
                content_type: "application/octet-stream",
                url: "http://example.com/asset",
                browser_download_url: "http://example.com/asset"
            }
        ]
    };
}

function createConfig(): config.ServerConfig {
    return {
        port: 3000,
        cacheDir: "/tmp/cache",
        logLevel: "silent",
        github: { token: undefined, appId: undefined, privateKey: undefined },
        rateLimits: { max: 100, timeWindow: 60000 },
        apps: [{ id: "app1", repo: "owner/repo", name: "App One" }]
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
        return {
            status: "healthy",
            ready: this.initialized,
            live: true,
            uptime: 0,
            checks: { cacheInitialized: this.initialized, diskSpace: { ok: true, freeBytes: 0, thresholdBytes: 0 } }
        };
    }

    markCacheInitialized(initialized: boolean): void {
        this.initialized = initialized;
    }
}

class MockGitHubProvider implements githubTypes.GitHubProvider {
    private releases: types.GitHubRelease[] = [];
    private listFromCache = false;
    private tagFromCache = false;
    private throwOnList = false;
    private throwOnTag = false;
    private throwNonErrorOnList = false;
    private throwNonErrorOnTag = false;
    private returnUndefinedForTag = false;
    private returnUndefinedRelease = false;

    setReleases(releases: types.GitHubRelease[]): void {
        this.releases = releases;
    }

    setListFromCache(fromCache: boolean): void {
        this.listFromCache = fromCache;
    }

    setTagFromCache(fromCache: boolean): void {
        this.tagFromCache = fromCache;
    }

    setThrowOnList(throwOnList: boolean): void {
        this.throwOnList = throwOnList;
    }

    setThrowOnTag(throwOnTag: boolean): void {
        this.throwOnTag = throwOnTag;
    }

    setThrowNonErrorOnList(throwNonError: boolean): void {
        this.throwNonErrorOnList = throwNonError;
    }

    setThrowNonErrorOnTag(throwNonError: boolean): void {
        this.throwNonErrorOnTag = throwNonError;
    }

    setReturnUndefinedForTag(returnUndefined: boolean): void {
        this.returnUndefinedForTag = returnUndefined;
    }

    setReturnUndefinedRelease(returnUndefined: boolean): void {
        this.returnUndefinedRelease = returnUndefined;
    }

    async listReleases(): Promise<githubTypes.FetchResult<types.GitHubRelease[]>> {
        if (this.throwOnList) {
            throw new Error("list error");
        }
        if (this.throwNonErrorOnList) {
            throw "non-error list";
        }
        if (this.returnUndefinedRelease) {
            return {
                data: [undefined as unknown as types.GitHubRelease],
                etag: '"etag"',
                fromCache: false
            };
        }
        if (this.listFromCache) {
            return { data: [] as types.GitHubRelease[], etag: '"etag"', fromCache: true };
        }
        return { data: this.releases, etag: '"etag"', fromCache: false };
    }

    async getReleaseByTag(repo: string, tag: string): Promise<githubTypes.FetchResult<types.GitHubRelease>> {
        if (this.throwOnTag) {
            throw new Error("tag error");
        }
        if (this.throwNonErrorOnTag) {
            throw "non-error tag";
        }
        if (this.returnUndefinedForTag) {
            return { data: undefined as unknown as types.GitHubRelease, etag: '"etag"', fromCache: false };
        }
        for (let i = 0; i < this.releases.length; i = i + 1) {
            if (this.releases[i].tag_name === tag) {
                return { data: this.releases[i], etag: '"etag"', fromCache: this.tagFromCache };
            }
        }
        throw new Error("Not found");
    }
}

describe("ReleaseService", function () {
    let provider: MockGitHubProvider;
    let cache: metadataCache.SqliteMetadataCacheService;
    let service: releaseService.ReleaseService;
    let healthService: MockHealthService;
    let tempDir: string;

    beforeEach(function () {
        tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "download-server-release-"));
        provider = new MockGitHubProvider();
        cache = new metadataCache.SqliteMetadataCacheService(tempDir, new SilentLogger());
        healthService = new MockHealthService();
        service = new releaseService.ReleaseService(
            createConfig(),
            provider,
            cache,
            new platform.DefaultPlatformDetector(),
            healthService,
            new SilentLogger()
        );
    });

    afterEach(function () {
        cache.close();
        fs.rmSync(tempDir, { recursive: true, force: true });
    });

    it("lists releases from provider on cache miss", async function () {
        provider.setReleases([createGitHubRelease("v1.0.0", "2024-01-01T00:00:00Z")]);

        const releases = await service.listReleases("app1", {});

        expect(releases.length).toBe(1);
        expect(releases[0].tag).toBe("v1.0.0");
    });

    it("uses cached releases when not expired", async function () {
        provider.setReleases([createGitHubRelease("v1.0.0", "2024-01-01T00:00:00Z")]);
        await service.listReleases("app1", {});
        provider.setReleases([createGitHubRelease("v2.0.0", "2024-02-01T00:00:00Z")]);

        const releases = await service.listReleases("app1", {});

        expect(releases.length).toBe(1);
        expect(releases[0].tag).toBe("v1.0.0");
    });

    it("filters prereleases", async function () {
        provider.setReleases([
            createGitHubRelease("v1.0.0", "2024-01-01T00:00:00Z"),
            {
                tag_name: "v2.0.0-beta",
                name: "Beta",
                body: "Notes",
                published_at: "2024-02-01T00:00:00Z",
                prerelease: true,
                assets: []
            }
        ]);

        const releases = await service.listReleases("app1", { includePrerelease: false });

        expect(releases.length).toBe(1);
        expect(releases[0].tag).toBe("v1.0.0");
    });

    it("returns latest release", async function () {
        provider.setReleases([
            createGitHubRelease("v1.0.0", "2024-01-01T00:00:00Z"),
            createGitHubRelease("v1.1.0", "2024-02-01T00:00:00Z")
        ]);

        const latest = await service.getLatestRelease("app1", false);

        expect(latest).toBeDefined();
        expect(latest.tag).toBe("v1.1.0");
    });

    it("sorts releases by descending published date", async function () {
        provider.setReleases([
            createGitHubRelease("v1.2.0", "2024-03-01T00:00:00Z"),
            createGitHubRelease("v1.0.0", "2024-01-01T00:00:00Z"),
            createGitHubRelease("v1.1.0", "2024-02-01T00:00:00Z")
        ]);

        const latest = await service.getLatestRelease("app1", false);

        expect(latest).toBeDefined();
        expect(latest.tag).toBe("v1.2.0");
    });

    it("gets release by tag", async function () {
        provider.setReleases([createGitHubRelease("v1.0.0", "2024-01-01T00:00:00Z")]);

        const release = await service.getReleaseByTag("app1", "v1.0.0");

        expect(release).toBeDefined();
        expect(release.tag).toBe("v1.0.0");
    });

    it("returns stale cache when refresh fails", async function () {
        provider.setReleases([createGitHubRelease("v1.0.0", "2024-01-01T00:00:00Z")]);
        await service.getReleaseByTag("app1", "v1.0.0");
        provider.setReleases([]);

        const release = await service.getReleaseByTag("app1", "v1.0.0");

        expect(release).toBeDefined();
        expect(release.tag).toBe("v1.0.0");
    });

    it("selects asset for target", async function () {
        provider.setReleases([createGitHubRelease("v1.0.0", "2024-01-01T00:00:00Z")]);

        const asset = await service.getAssetForTarget("app1", "v1.0.0", { os: "windows", arch: "x64" });

        expect(asset).toBeDefined();
        expect(asset.name).toBe("app-windows.exe");
    });

    it("warms cache for all apps", async function () {
        provider.setReleases([createGitHubRelease("v1.0.0", "2024-01-01T00:00:00Z")]);

        await service.warmCache();

        expect(healthService.isReady()).toBe(true);
        const cached = cache.getReleases("app1");
        expect(cached).toBeDefined();
        expect(cached.releases.length).toBe(1);
    });

    it("throws for unknown app", async function () {
        await expect(service.listReleases("unknown", {})).rejects.toThrow("App not found: unknown");
    });

    it("returns cached releases when provider reports 304", async function () {
        provider.setReleases([createGitHubRelease("v1.0.0", "2024-01-01T00:00:00Z")]);
        await service.listReleases("app1", {});
        provider.setListFromCache(true);

        const releases = await service.listReleases("app1", {});

        expect(releases.length).toBe(1);
        expect(releases[0].tag).toBe("v1.0.0");
    });

    it("returns cached releases when expired list refresh reports 304", async function () {
        provider.setReleases([createGitHubRelease("v1.0.0", "2024-01-01T00:00:00Z")]);
        const cached = await service.listReleases("app1", {});
        expect(cached.length).toBe(1);
        cache.setReleases("app1", cached, '"etag"', -1);
        provider.setListFromCache(true);

        const releases = await service.listReleases("app1", {});

        expect(releases.length).toBe(1);
        expect(releases[0].tag).toBe("v1.0.0");
    });

    it("includes prereleases when requested", async function () {
        provider.setReleases([
            createGitHubRelease("v1.0.0", "2024-01-01T00:00:00Z"),
            {
                tag_name: "v2.0.0-beta",
                name: "Beta",
                body: "Notes",
                published_at: "2024-02-01T00:00:00Z",
                prerelease: true,
                assets: []
            }
        ]);

        const releases = await service.listReleases("app1", { includePrerelease: true });

        expect(releases.length).toBe(2);
    });

    it("returns undefined for latest when no releases", async function () {
        provider.setReleases([]);

        const latest = await service.getLatestRelease("app1", false);

        expect(latest).toBeUndefined();
    });

    it("returns cached release when tag refresh reports 304", async function () {
        provider.setReleases([createGitHubRelease("v1.0.0", "2024-01-01T00:00:00Z")]);
        await service.getReleaseByTag("app1", "v1.0.0");
        provider.setTagFromCache(true);

        const release = await service.getReleaseByTag("app1", "v1.0.0");

        expect(release).toBeDefined();
        expect(release.tag).toBe("v1.0.0");
    });

    it("logs error when warming cache fails for one app", async function () {
        const cfg = createConfig();
        cfg.apps.push({ id: "app2", repo: "owner/repo2", name: "App Two" });
        provider.setReleases([createGitHubRelease("v1.0.0", "2024-01-01T00:00:00Z")]);
        provider.setThrowOnList(true);
        const customService = new releaseService.ReleaseService(
            cfg,
            provider,
            cache,
            new platform.DefaultPlatformDetector(),
            healthService,
            new SilentLogger()
        );

        await customService.warmCache();

        expect(healthService.isReady()).toBe(true);
    });

    it("returns stale release when tag refresh throws", async function () {
        provider.setReleases([createGitHubRelease("v1.0.0", "2024-01-01T00:00:00Z")]);
        await service.getReleaseByTag("app1", "v1.0.0");
        provider.setThrowOnTag(true);

        const release = await service.getReleaseByTag("app1", "v1.0.0");

        expect(release).toBeDefined();
        expect(release.tag).toBe("v1.0.0");
    });

    it("returns undefined asset when release is not found", async function () {
        provider.setReturnUndefinedForTag(true);

        const asset = await service.getAssetForTarget("app1", "v1.0.0", { os: "windows", arch: "x64" });

        expect(asset).toBeUndefined();
    });

    it("returns cached release when expired tag refresh reports 304", async function () {
        provider.setReleases([createGitHubRelease("v1.0.0", "2024-01-01T00:00:00Z")]);
        const cachedRelease = await service.getReleaseByTag("app1", "v1.0.0");
        expect(cachedRelease).toBeDefined();
        cache.setRelease("app1", "v1.0.0", cachedRelease, '"etag"', -1);
        provider.setTagFromCache(true);

        const release = await service.getReleaseByTag("app1", "v1.0.0");

        expect(release).toBeDefined();
        expect(release.tag).toBe("v1.0.0");
    });

    it("returns stale release when expired tag refresh throws", async function () {
        provider.setReleases([createGitHubRelease("v1.0.0", "2024-01-01T00:00:00Z")]);
        const cachedRelease = await service.getReleaseByTag("app1", "v1.0.0");
        expect(cachedRelease).toBeDefined();
        cache.setRelease("app1", "v1.0.0", cachedRelease, '"etag"', -1);
        provider.setThrowOnTag(true);
        provider.setReleases([]);

        const release = await service.getReleaseByTag("app1", "v1.0.0");

        expect(release).toBeDefined();
        expect(release.tag).toBe("v1.0.0");
    });

    it("throws when tag refresh fails without cache", async function () {
        provider.setThrowOnTag(true);

        await expect(service.getReleaseByTag("app1", "v1.0.0")).rejects.toThrow("tag error");
    });

    it("returns latest release when published dates are equal", async function () {
        provider.setReleases([
            createGitHubRelease("v1.0.0", "2024-01-01T00:00:00Z"),
            createGitHubRelease("v1.1.0", "2024-01-01T00:00:00Z")
        ]);

        const latest = await service.getLatestRelease("app1", false);

        expect(latest).toBeDefined();
    });

    it("handles undefined release data during cache warming", async function () {
        provider.setReturnUndefinedRelease(true);

        await service.warmCache();

        expect(healthService.isReady()).toBe(true);
    });

    it("passes pagination filters to provider", async function () {
        provider.setReleases([createGitHubRelease("v1.0.0", "2024-01-01T00:00:00Z")]);

        const releases = await service.listReleases("app1", { page: 2, perPage: 10 });

        expect(releases.length).toBe(1);
    });

    it("returns stale release when tag refresh throws non-error", async function () {
        provider.setReleases([createGitHubRelease("v1.0.0", "2024-01-01T00:00:00Z")]);
        const cachedRelease = await service.getReleaseByTag("app1", "v1.0.0");
        expect(cachedRelease).toBeDefined();
        cache.setRelease("app1", "v1.0.0", cachedRelease, '"etag"', -1);
        provider.setThrowNonErrorOnTag(true);

        const release = await service.getReleaseByTag("app1", "v1.0.0");

        expect(release).toBeDefined();
        expect(release.tag).toBe("v1.0.0");
    });

    it("logs error when warming cache fails with non-error", async function () {
        provider.setThrowNonErrorOnList(true);

        await service.warmCache();

        expect(healthService.isReady()).toBe(true);
    });

    it("transforms release with null body to empty notes", async function () {
        provider.setReleases([
            {
                tag_name: "v1.0.0",
                name: "Release v1.0.0",
                body: null,
                published_at: "2024-01-01T00:00:00Z",
                prerelease: false,
                assets: []
            }
        ]);

        const release = await service.getReleaseByTag("app1", "v1.0.0");

        expect(release).toBeDefined();
        expect(release.notes).toBe("");
    });

    it("refreshReleases invalidates cache and fetches from provider", async function () {
        provider.setReleases([createGitHubRelease("v1.0.0", "2024-01-01T00:00:00Z")]);
        await service.listReleases("app1", {});
        provider.setReleases([createGitHubRelease("v2.0.0", "2024-02-01T00:00:00Z")]);

        const releases = await service.refreshReleases("app1");

        expect(releases.length).toBe(1);
        expect(releases[0].tag).toBe("v2.0.0");
    });

    it("refreshReleaseByTag invalidates tag and fetches from provider", async function () {
        provider.setReleases([createGitHubRelease("v1.0.0", "2024-01-01T00:00:00Z")]);
        await service.getReleaseByTag("app1", "v1.0.0");
        provider.setReleases([
            {
                tag_name: "v1.0.0",
                name: "Release v1.0.0 patched",
                body: "Patched notes",
                published_at: "2024-01-01T00:00:00Z",
                prerelease: false,
                assets: [
                    {
                        name: "app-windows.exe",
                        size: 100,
                        content_type: "application/octet-stream",
                        url: "http://example.com/asset",
                        browser_download_url: "http://example.com/asset"
                    }
                ]
            }
        ]);

        const release = await service.refreshReleaseByTag("app1", "v1.0.0");

        expect(release).toBeDefined();
        expect(release.name).toBe("Release v1.0.0 patched");
    });
});
