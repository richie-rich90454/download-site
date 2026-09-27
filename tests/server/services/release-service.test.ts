import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as types from "../../../src/shared/types.js";
import * as config from "../../../src/server/config/config.js";
import * as githubTypes from "../../../src/server/github/github-types.js";
import * as metadataCache from "../../../src/server/cache/metadata-cache.js";
import * as assetCache from "../../../src/server/cache/asset-cache.js";
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

class MockAssetCache implements assetCache.AssetCacheService {
    private checksums: Record<string, string> = {};

    setChecksum(app: string, version: string, assetName: string, checksum: string): void {
        this.checksums[app + "/" + version + "/" + assetName] = checksum;
    }

    async getAssetPath(): Promise<assetCache.AssetCacheResult> {
        return {
            filePath: "/tmp/asset.exe",
            cached: true,
            entry: {
                app: "app1",
                version: "v1.0.0",
                assetName: "app-windows.exe",
                filePath: "/tmp/asset.exe",
                size: 100,
                checksum: "",
                lastAccessedAt: Date.now(),
                createdAt: Date.now()
            }
        };
    }

    getChecksum(app: string, version: string, assetName: string): string | undefined {
        return this.checksums[app + "/" + version + "/" + assetName];
    }

    purge(): void {
        // no-op
    }

    close(): void {
        // no-op
    }
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
    /** Counts upstream list calls so a test can prove a read was served from cache. */
    listCalls = 0;
    /** Counts upstream tag calls, to prove an unknown tag costs nothing. */
    tagCalls = 0;

    setReleases(releases: types.GitHubRelease[]): void {
        this.releases = releases;
    }

    /** Sets the release a single tag lookup resolves to, for the cold-start path. */
    setTagRelease(release: types.GitHubRelease): void {
        this.releases = [release];
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
        this.listCalls += 1;
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
        this.tagCalls += 1;
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
    let assetCacheSvc: MockAssetCache;
    let service: releaseService.ReleaseService;
    let healthService: MockHealthService;
    let tempDir: string;

    beforeEach(function () {
        tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "download-server-release-"));
        provider = new MockGitHubProvider();
        cache = new metadataCache.SqliteMetadataCacheService(tempDir, new SilentLogger());
        assetCacheSvc = new MockAssetCache();
        healthService = new MockHealthService();
        service = new releaseService.ReleaseService(
            createConfig(),
            provider,
            cache,
            assetCacheSvc,
            new platform.DefaultPlatformDetector(),
            healthService,
            new SilentLogger()
        );
    });

    afterEach(function () {
        cache.close();
        fs.rmSync(tempDir, { recursive: true, force: true });
    });

    it("pages a warm cache without decoding the whole history", async function () {
        const tags = ["v1.0.0", "v1.1.0", "v1.2.0", "v1.3.0", "v1.4.0"];
        provider.setReleases(
            tags.map(function (tag, index) {
                return createGitHubRelease(tag, "2024-0" + String(index + 1) + "-01T00:00:00Z");
            })
        );
        // Cold first, so the cache is warm for the call that matters.
        await service.listReleases("app1", {});

        const page = await service.listReleasesPage("app1", { page: 2, perPage: 2 });

        // The total is the whole archive; the payload is one page. A caller can show page
        // numbers without the server handing over every release.
        expect(page.total).toBe(5);
        expect(page.releases.length).toBe(2);
        expect(page.releases[0].tag).toBe("v1.2.0");
        expect(page.releases[1].tag).toBe("v1.1.0");
    });

    it("returns an empty page past the end rather than an error", async function () {
        provider.setReleases([createGitHubRelease("v1.0.0", "2024-01-01T00:00:00Z")]);
        await service.listReleases("app1", {});

        const page = await service.listReleasesPage("app1", { page: 9, perPage: 10 });

        expect(page.releases.length).toBe(0);
        expect(page.total).toBe(1);
    });

    it("pages a cold cache from the provider result", async function () {
        provider.setReleases([
            createGitHubRelease("v1.0.0", "2024-01-01T00:00:00Z"),
            createGitHubRelease("v1.1.0", "2024-02-01T00:00:00Z"),
            createGitHubRelease("v1.2.0", "2024-03-01T00:00:00Z")
        ]);

        const page = await service.listReleasesPage("app1", { page: 2, perPage: 1 });

        expect(page.releases.length).toBe(1);
        expect(page.releases[0].tag).toBe("v1.1.0");
        expect(page.total).toBe(3);
    });

    it("clamps a cold page whose offset is past the end", async function () {
        provider.setReleases([createGitHubRelease("v1.0.0", "2024-01-01T00:00:00Z")]);

        const page = await service.listReleasesPage("app1", { page: 5, perPage: 10 });

        expect(page.releases.length).toBe(0);
    });

    it("defaults to the first page of thirty when no page is asked for", async function () {
        provider.setReleases([createGitHubRelease("v1.0.0", "2024-01-01T00:00:00Z")]);
        await service.listReleases("app1", {});

        const page = await service.listReleasesPage("app1", {});

        expect(page.releases.length).toBe(1);
        expect(page.total).toBe(1);
    });

    it("refetches one app on demand, bypassing the cache", async function () {
        provider.setReleases([createGitHubRelease("v1.0.0", "2024-01-01T00:00:00Z")]);
        // Warm first, so the cache is demonstrably bypassed rather than merely empty.
        await service.listReleases("app1", {});
        const before = cache.getLatestRelease("app1", false);
        expect(before !== undefined ? before.release.tag : undefined).toBe("v1.0.0");

        provider.setReleases([createGitHubRelease("v2.0.0", "2024-06-01T00:00:00Z")]);
        await service.refreshApp("app1");

        // The webhook path exists so the first user after a release does not see the old data.
        const after = cache.getLatestRelease("app1", false);
        expect(after !== undefined ? after.release.tag : undefined).toBe("v2.0.0");
    });

    it("refuses to refresh an app it does not serve", async function () {
        await expect(service.refreshApp("not-configured")).rejects.toThrow();
    });

    it("lists releases from provider on cache miss", async function () {
        provider.setReleases([createGitHubRelease("v1.0.0", "2024-01-01T00:00:00Z")]);

        const releases = await service.listReleases("app1", {});

        expect(releases.length).toBe(1);
        expect(releases[0].tag).toBe("v1.0.0");
    });

    it("includes cached checksum in transformed assets", async function () {
        assetCacheSvc.setChecksum("app1", "v1.0.0", "app-windows.exe", "abc123");
        provider.setReleases([createGitHubRelease("v1.0.0", "2024-01-01T00:00:00Z")]);

        const release = await service.getReleaseByTag("app1", "v1.0.0");

        expect(release).toBeDefined();
        expect(release.assets.length).toBe(1);
        expect(release.assets[0].checksum).toBe("abc123");
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

    it("serves the latest release from the O(1) cache on a repeat call", async function () {
        provider.setReleases([
            createGitHubRelease("v1.0.0", "2024-01-01T00:00:00Z"),
            createGitHubRelease("v1.1.0", "2024-02-01T00:00:00Z")
        ]);

        const first = await service.getLatestRelease("app1", false);
        const callsAfterFirst = provider.listCalls;
        const second = await service.getLatestRelease("app1", false);

        expect(first).toBeDefined();
        expect(second !== undefined ? second.tag : undefined).toBe("v1.1.0");
        // The second call must be answered from cache without touching GitHub.
        expect(provider.listCalls).toBe(callsAfterFirst);
    });
    describe("unknown tag refusal", function () {
        it("does not call GitHub for a tag absent from a known release list", async function () {
            provider.setReleases([createGitHubRelease("v1.0.0", "2024-01-01T00:00:00Z")]);
            await service.listReleases("app1", {});
            const callsBefore = provider.listCalls;
            const tagCallsBefore = provider.tagCalls;

            const result = await service.getReleaseByTag("app1", "v9.9.9-not-real");

            expect(result).toBeUndefined();
            // The point of the fix: an unknown tag costs zero upstream requests, so a client
            // cannot walk the tag space to exhaust the hourly GitHub quota.
            expect(provider.listCalls).toBe(callsBefore);
            expect(provider.tagCalls).toBe(tagCallsBefore);
        });

        it("still serves a tag that is in the cached list", async function () {
            provider.setReleases([
                createGitHubRelease("v1.0.0", "2024-01-01T00:00:00Z"),
                createGitHubRelease("v1.1.0", "2024-02-01T00:00:00Z")
            ]);
            await service.listReleases("app1", {});

            const result = await service.getReleaseByTag("app1", "v1.1.0");

            expect(result).toBeDefined();
            expect(result.tag).toBe("v1.1.0");
        });

        it("finds a known tag beyond the first page window", async function () {
            const many: types.GitHubRelease[] = [];
            for (let i = 0; i < 400; i = i + 1) {
                many.push(createGitHubRelease("v0." + String(i) + ".0", "2024-01-01T00:00:00Z"));
            }
            provider.setReleases(many);
            await service.listReleases("app1", {});

            const result = await service.getReleaseByTag("app1", "v0.399.0");

            expect(result !== undefined ? result.tag : undefined).toBe("v0.399.0");
        });

        it("walks past the last full page when scanning for a tag", async function () {
            const many: types.GitHubRelease[] = [];
            for (let i = 0; i < 400; i = i + 1) {
                many.push(createGitHubRelease("v0." + String(i) + ".0", "2024-01-01T00:00:00Z"));
            }
            provider.setReleases(many);
            await service.listReleases("app1", {});
            const tagCallsBefore = provider.tagCalls;

            // Exactly two full pages, so the scan reaches a third, empty one.
            const result = await service.getReleaseByTag("app1", "v9-absent");

            expect(result).toBeUndefined();
            expect(provider.tagCalls).toBe(tagCallsBefore);
        });
        it("allows the fetch when nothing is cached, as on a cold start", async function () {
            provider.setTagRelease(createGitHubRelease("v1.0.0", "2024-01-01T00:00:00Z"));
            const tagCallsBefore = provider.tagCalls;

            const result = await service.getReleaseByTag("app1", "v1.0.0");

            expect(result).toBeDefined();
            expect(provider.tagCalls).toBe(tagCallsBefore + 1);
        });

        it("allows the explicit admin refresh path to bypass the check", async function () {
            provider.setReleases([createGitHubRelease("v1.0.0", "2024-01-01T00:00:00Z")]);
            await service.listReleases("app1", {});
            provider.setTagRelease(createGitHubRelease("v7.7.7", "2024-09-01T00:00:00Z"));

            const result = await service.refreshReleaseByTag("app1", "v7.7.7");

            expect(result !== undefined ? result.tag : undefined).toBe("v7.7.7");
        });
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
        await expect(service.listReleases("unknown", {})).rejects.toThrow(
            "There is no app registered under that name."
        );
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
            assetCacheSvc,
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

    it("refreshReleases passes pagination filters to provider", async function () {
        provider.setReleases([createGitHubRelease("v1.0.0", "2024-01-01T00:00:00Z")]);
        const spy = vi.spyOn(provider, "listReleases");

        const releases = await service.refreshReleases("app1", { page: 3, perPage: 50 });

        expect(releases.length).toBe(1);
        expect(spy).toHaveBeenCalledWith("owner/repo", { page: 3, perPage: 50 });
        spy.mockRestore();
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
