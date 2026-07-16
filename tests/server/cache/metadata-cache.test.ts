import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as types from "../../../src/shared/types.js";
import * as metadataCache from "../../../src/server/cache/metadata-cache.js";
import { SilentLogger } from "../test-helpers.js";

function createRelease(tag: string, prerelease: boolean): types.Release {
    return {
        tag: tag,
        name: "Release " + tag,
        notes: "Notes for " + tag,
        publishedAt: "2024-01-01T00:00:00Z",
        prerelease: prerelease,
        assets: []
    };
}

describe("SqliteMetadataCacheService", function () {
    let tempDir: string;
    let cache: metadataCache.SqliteMetadataCacheService;

    beforeEach(function () {
        tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "download-server-metadata-"));
        cache = new metadataCache.SqliteMetadataCacheService(tempDir, new SilentLogger());
    });

    afterEach(function () {
        cache.close();
        fs.rmSync(tempDir, { recursive: true, force: true });
    });

    it("returns undefined for missing releases", function () {
        const result = cache.getReleases("app1");

        expect(result).toBeUndefined();
    });

    it("stores and retrieves releases", function () {
        const releases = [createRelease("v1.0.0", false)];

        cache.setReleases("app1", releases, '"etag1"', 60);
        const result = cache.getReleases("app1");

        expect(result).toBeDefined();
        expect(result.releases.length).toBe(1);
        expect(result.releases[0].tag).toBe("v1.0.0");
        expect(result.etag).toBe('"etag1"');
        expect(result.expiresAt > Date.now()).toBe(true);
    });

    it("stores and retrieves a release by tag", function () {
        const release = createRelease("v1.0.0", false);

        cache.setRelease("app1", "v1.0.0", release, '"etag1"', 60);
        const result = cache.getReleaseByTag("app1", "v1.0.0");

        expect(result).toBeDefined();
        expect(result.release.tag).toBe("v1.0.0");
        expect(result.etag).toBe('"etag1"');
    });

    it("filters prereleases when requested", function () {
        const releases = [createRelease("v1.0.0", false), createRelease("v2.0.0-beta", true)];

        cache.setReleases("app1", releases, undefined, 60);
        const result = cache.getReleases("app1", { includePrerelease: false });

        expect(result.releases.length).toBe(1);
        expect(result.releases[0].tag).toBe("v1.0.0");
    });

    it("includes prereleases when requested", function () {
        const releases = [createRelease("v1.0.0", false), createRelease("v2.0.0-beta", true)];

        cache.setReleases("app1", releases, undefined, 60);
        const result = cache.getReleases("app1", { includePrerelease: true });

        expect(result.releases.length).toBe(2);
    });

    it("invalidates by app", function () {
        cache.setReleases("app1", [createRelease("v1.0.0", false)], undefined, 60);
        cache.setReleases("app2", [createRelease("v1.0.0", false)], undefined, 60);

        cache.invalidateApp("app1");

        expect(cache.getReleases("app1")).toBeUndefined();
        expect(cache.getReleases("app2")).toBeDefined();
    });

    it("invalidates by tag", function () {
        cache.setRelease("app1", "v1.0.0", createRelease("v1.0.0", false), undefined, 60);
        cache.setRelease("app1", "v1.1.0", createRelease("v1.1.0", false), undefined, 60);

        cache.invalidateTag("app1", "v1.0.0");

        expect(cache.getReleaseByTag("app1", "v1.0.0")).toBeUndefined();
        expect(cache.getReleaseByTag("app1", "v1.1.0")).toBeDefined();
    });

    it("invalidates all", function () {
        cache.setReleases("app1", [createRelease("v1.0.0", false)], undefined, 60);
        cache.setReleases("app2", [createRelease("v1.0.0", false)], undefined, 60);

        cache.invalidateAll();

        expect(cache.getReleases("app1")).toBeUndefined();
        expect(cache.getReleases("app2")).toBeUndefined();
    });

    it("returns undefined when all releases are filtered out", function () {
        const releases = [createRelease("v2.0.0-beta", true)];

        cache.setReleases("app1", releases, undefined, 60);
        const result = cache.getReleases("app1", { includePrerelease: false });

        expect(result).toBeUndefined();
    });

    it("creates cache directory when it does not exist", function () {
        const nestedDir = path.join(tempDir, "nested", "cache");
        const service = new metadataCache.SqliteMetadataCacheService(nestedDir, new SilentLogger());

        expect(fs.existsSync(nestedDir)).toBe(true);
        service.close();
    });

    it("updates existing release entry", function () {
        const release = createRelease("v1.0.0", false);
        cache.setRelease("app1", "v1.0.0", release, '"etag1"', 60);
        const updatedRelease = createRelease("v1.0.0", false);
        updatedRelease.name = "Updated";

        cache.setRelease("app1", "v1.0.0", updatedRelease, '"etag2"', 60);
        const result = cache.getReleaseByTag("app1", "v1.0.0");

        expect(result).toBeDefined();
        expect(result.release.name).toBe("Updated");
        expect(result.etag).toBe('"etag2"');
    });
});
