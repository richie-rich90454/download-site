import { describe, it, expect, beforeEach, afterEach } from "vitest";

import * as fs from "node:fs";

import * as os from "node:os";

import * as path from "node:path";

import * as types from "../../../src/shared/types.js";

import * as metadataCache from "../../../src/server/cache/metadata-cache.js";

import Database from "better-sqlite3";

import * as msgpackr from "msgpackr";

import { SilentLogger } from "../test-helpers.js";

function createRelease(tag: string, prerelease: boolean, publishedAt?: string): types.Release {
    return {
        tag: tag,

        name: "Release " + tag,

        notes: "Notes for " + tag,

        publishedAt: publishedAt !== undefined ? publishedAt : "2024-01-01T00:00:00Z",

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

        expect(result !== undefined ? result.releases.length : 0).toBe(1);

        expect(result !== undefined ? result.releases[0].tag : undefined).toBe("v1.0.0");

        expect(result !== undefined ? result.etag : undefined).toBe('"etag1"');

        expect(result !== undefined ? result.expiresAt > Date.now() : false).toBe(true);
    });

    it("stores and retrieves a release by tag", function () {
        const release = createRelease("v1.0.0", false);

        cache.setRelease("app1", "v1.0.0", release, '"etag1"', 60);

        const result = cache.getReleaseByTag("app1", "v1.0.0");

        expect(result).toBeDefined();

        expect(result !== undefined ? result.release.tag : undefined).toBe("v1.0.0");

        expect(result !== undefined ? result.etag : undefined).toBe('"etag1"');
    });

    it("filters prereleases when requested", function () {
        const releases = [createRelease("v1.0.0", false), createRelease("v2.0.0-beta", true)];

        cache.setReleases("app1", releases, undefined, 60);

        const result = cache.getReleases("app1", { includePrerelease: false });

        expect(result !== undefined ? result.releases.length : 0).toBe(1);

        expect(result !== undefined ? result.releases[0].tag : undefined).toBe("v1.0.0");
    });

    it("includes prereleases when requested", function () {
        const releases = [createRelease("v1.0.0", false), createRelease("v2.0.0-beta", true)];

        cache.setReleases("app1", releases, undefined, 60);

        const result = cache.getReleases("app1", { includePrerelease: true });

        expect(result !== undefined ? result.releases.length : 0).toBe(2);
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

        expect(result !== undefined ? result.release.name : undefined).toBe("Updated");

        expect(result !== undefined ? result.etag : undefined).toBe('"etag2"');
    });

    describe("O(1) latest resolution", function () {
        it("returns the newest stable release", function () {
            cache.setReleases(
                "app1",

                [
                    createRelease("v1.0.0", false, "2024-01-01T00:00:00Z"),

                    createRelease("v2.0.0", false, "2024-03-01T00:00:00Z"),

                    createRelease("v1.5.0", false, "2024-02-01T00:00:00Z")
                ],

                undefined,

                300
            );

            const latest = cache.getLatestRelease("app1", false);

            expect(latest !== undefined ? latest.release.tag : undefined).toBe("v2.0.0");
        });

        it("returns the newest release including prereleases for a beta channel", function () {
            cache.setReleases(
                "app1",

                [
                    createRelease("v2.0.0", false, "2024-03-01T00:00:00Z"),

                    createRelease("v3.0.0-beta.1", true, "2024-04-01T00:00:00Z")
                ],

                undefined,

                300
            );

            const latest = cache.getLatestRelease("app1", false);

            expect(latest !== undefined ? latest.release.tag : undefined).toBe("v2.0.0");

            const beta = cache.getLatestRelease("app1", true);

            expect(beta !== undefined ? beta.release.tag : undefined).toBe("v3.0.0-beta.1");
        });

        it("records a release whose published date cannot be parsed as zero", function () {
            // A zero timestamp keeps the row sortable and stops Date.parse throwing on write. Without
            // it, one bad date from GitHub would take the whole list endpoint down.
            cache.setRelease("app1", "v1.0.0", createRelease("v1.0.0", false, "not-a-date"), undefined, 60);

            const stored = cache.getReleaseByTag("app1", "v1.0.0");
            expect(stored !== undefined ? stored.release.tag : undefined).toBe("v1.0.0");
            // It was still written, just never ordered into a page by a timestamp that does not exist.
            expect(cache.countReleases("app1", false)).toBe(1);
        });

        it("points the stable channel at nothing when an app has only prereleases", function () {
            cache.setReleases(
                "beta-only",
                [createRelease("v1.0.0-beta.1", true, "2024-01-01T00:00:00Z")],
                undefined,
                60
            );

            // The pointer row exists but its stable tag is null, which must read as "no stable release"
            // rather than falling through to a scan that would find the prerelease.
            expect(cache.getLatestRelease("beta-only", false)).toBeUndefined();
            const beta = cache.getLatestRelease("beta-only", true);
            expect(beta !== undefined ? beta.release.tag : undefined).toBe("v1.0.0-beta.1");
        });

        it("reports no etag for a release cached without one", function () {
            cache.setRelease("app1", "v1.0.0", createRelease("v1.0.0", false), undefined, 60);

            const stored = cache.getReleaseByTag("app1", "v1.0.0");
            expect(stored !== undefined ? stored.etag : "set").toBeUndefined();
        });

        it("reports no etag when the scan path finds a release cached without one", function () {
            // setRelease writes no pointer row, so this goes through the scan rather than the pointer.
            cache.setRelease("app1", "v1.0.0", createRelease("v1.0.0", false), undefined, 60);

            const scanned = cache.getLatestRelease("app1", false);
            expect(scanned).toBeDefined();
            expect(scanned !== undefined ? scanned.etag : "set").toBeUndefined();
        });

        it("treats an unparseable date as zero when refreshing the channel pointers", function () {
            // The pointer pass runs over the whole set, so one bad date must not stop the rest of an
            // app's channels from being pointed at the right release.
            cache.setReleases(
                "app1",
                [createRelease("v-good", false, "2024-05-01T00:00:00Z"), createRelease("v-bad", true, "not-a-date")],
                undefined,
                60
            );

            const stable = cache.getLatestRelease("app1", false);
            expect(stable !== undefined ? stable.release.tag : undefined).toBe("v-good");
            const beta = cache.getLatestRelease("app1", true);
            expect(beta !== undefined ? beta.release.tag : undefined).toBe("v-good");
        });

        it("reports the etag the scan path found", function () {
            cache.setRelease("app1", "v1.0.0", createRelease("v1.0.0", false), 'W/"abc"', 60);

            const scanned = cache.getLatestRelease("app1", false);
            expect(scanned !== undefined ? scanned.etag : undefined).toBe('W/"abc"');
        });

        it("finds the newest release by scanning when the pointer row is missing", function () {
            // setRelease writes the release but not the pointer - only setReleases does that. This is
            // the path a database migrated from an older build takes on its first request.
            cache.setRelease("app1", "v1.0.0", createRelease("v1.0.0", false, "2024-01-01T00:00:00Z"), undefined, 300);
            cache.setRelease("app1", "v1.2.0", createRelease("v1.2.0", false, "2024-03-01T00:00:00Z"), undefined, 300);
            cache.setRelease("app1", "v1.1.0", createRelease("v1.1.0", false, "2024-02-01T00:00:00Z"), undefined, 300);
            cache.setRelease(
                "app1",
                "v2.0.0-beta.1",
                createRelease("v2.0.0-beta.1", true, "2024-04-01T00:00:00Z"),
                undefined,
                300
            );

            const stable = cache.getLatestRelease("app1", false);
            expect(stable !== undefined ? stable.release.tag : undefined).toBe("v1.2.0");
            // The beta channel sees the prerelease even though the stable channel does not.
            const beta = cache.getLatestRelease("app1", true);
            expect(beta !== undefined ? beta.release.tag : undefined).toBe("v2.0.0-beta.1");
        });

        it("falls back to a scan when no pointer has been written", function () {
            cache.setRelease("app1", "v1.0.0", createRelease("v1.0.0", false, "2024-01-01T00:00:00Z"), undefined, 300);

            cache.invalidateTag("app1", "v1.0.0");

            expect(cache.getLatestRelease("app1", false)).toBeUndefined();
        });

        it("returns undefined for an unknown app", function () {
            expect(cache.getLatestRelease("missing", false)).toBeUndefined();
        });

        it("returns undefined when the pointer names a deleted release", function () {
            cache.setReleases("app1", [createRelease("v1.0.0", false)], undefined, 300);

            cache.invalidateApp("app1");

            expect(cache.getLatestRelease("app1", false)).toBeUndefined();
        });
    });

    describe("paginated release reads", function () {
        it("returns one page newest first", function () {
            cache.setReleases(
                "app1",

                [
                    createRelease("v1.0.0", false, "2024-01-01T00:00:00Z"),

                    createRelease("v2.0.0", false, "2024-02-01T00:00:00Z"),

                    createRelease("v3.0.0", false, "2024-03-01T00:00:00Z")
                ],

                undefined,

                300
            );

            const first = cache.getReleasePage("app1", 2, 0, false);

            expect(first.length).toBe(2);

            expect(first[0].tag).toBe("v3.0.0");

            expect(first[1].tag).toBe("v2.0.0");
        });

        it("honours the offset instead of slicing in memory", function () {
            cache.setReleases(
                "app1",

                [
                    createRelease("v1.0.0", false, "2024-01-01T00:00:00Z"),

                    createRelease("v2.0.0", false, "2024-02-01T00:00:00Z"),

                    createRelease("v3.0.0", false, "2024-03-01T00:00:00Z")
                ],

                undefined,

                300
            );

            const second = cache.getReleasePage("app1", 2, 2, false);

            expect(second.length).toBe(1);

            expect(second[0].tag).toBe("v1.0.0");
        });

        it("excludes prereleases from the stable channel", function () {
            cache.setReleases(
                "app1",

                [
                    createRelease("v1.0.0", false, "2024-01-01T00:00:00Z"),

                    createRelease("v2.0.0-beta.1", true, "2024-02-01T00:00:00Z")
                ],

                undefined,

                300
            );

            expect(cache.getReleasePage("app1", 10, 0, false).length).toBe(1);

            expect(cache.getReleasePage("app1", 10, 0, true).length).toBe(2);
        });

        it("returns an empty page beyond the end", function () {
            cache.setReleases("app1", [createRelease("v1.0.0", false)], undefined, 300);

            expect(cache.getReleasePage("app1", 10, 50, false).length).toBe(0);
        });
    });

    it("returns nothing for an app that has never been cached", function () {
        expect(cache.getReleases("never-seen")).toBeUndefined();
        expect(cache.countReleases("never-seen", false)).toBe(0);
        expect(cache.countReleases("never-seen", true)).toBe(0);
    });

    it("counts and pages the same set the list route will show", function () {
        // Six releases, three of them prereleases, so a stable page and a beta page cannot agree.
        const stable = ["v1.0.0", "v1.1.0", "v1.2.0"];
        for (let i = 0; i < stable.length; i = i + 1) {
            cache.setRelease("app1", stable[i], createRelease(stable[i], false), undefined, 60);
        }
        const beta = ["v2.0.0-beta.1", "v2.0.0-beta.2", "v2.0.0-beta.3"];
        for (let i = 0; i < beta.length; i = i + 1) {
            cache.setRelease("app1", beta[i], createRelease(beta[i], true), undefined, 60);
        }

        expect(cache.countReleases("app1", false)).toBe(3);
        expect(cache.countReleases("app1", true)).toBe(6);

        // Page 1 of the stable channel.
        const firstPage = cache.getReleasePage("app1", 2, 0, false);
        expect(firstPage.length).toBe(2);
        // Page 2 must be disjoint from page 1 - the bug this replaces ignored the offset entirely.
        const secondPage = cache.getReleasePage("app1", 2, 2, false);
        expect(secondPage.length).toBe(1);
        const seen: string[] = [];
        for (let i = 0; i < firstPage.length; i = i + 1) {
            seen.push(firstPage[i].tag);
        }
        for (let i = 0; i < secondPage.length; i = i + 1) {
            expect(seen.indexOf(secondPage[i].tag)).toBe(-1);
        }
        // Past the end is empty rather than an error.
        expect(cache.getReleasePage("app1", 2, 99, false).length).toBe(0);
    });

    it("discards a database written before these migrations existed", function () {
        // A separate directory: beforeEach has already created a current-schema database.
        const legacyDir = fs.mkdtempSync(path.join(os.tmpdir(), "download-server-legacy-"));
        const dbPath = path.join(legacyDir, "metadata.db");

        const legacy = new Database(dbPath);
        legacy.exec(`
            CREATE TABLE releases (
                app TEXT NOT NULL,
                tag TEXT NOT NULL,
                data BLOB NOT NULL,
                etag TEXT,
                fetched_at INTEGER NOT NULL,
                expires_at INTEGER NOT NULL,
                PRIMARY KEY (app, tag)
            );
            CREATE TABLE app_state (
                app TEXT PRIMARY KEY,
                latest_tag TEXT,
                latest_beta_tag TEXT,
                list_etag TEXT,
                updated_at INTEGER NOT NULL DEFAULT 0
            );
        `);
        legacy
            .prepare("INSERT INTO releases (app, tag, data, fetched_at, expires_at) VALUES (?, ?, ?, ?, ?)")
            .run("stale", "v0.0.1", msgpackr.pack(createRelease("v0.0.1", false)), Date.now(), Date.now() + 60000);
        legacy.close();

        const rebuilt = new metadataCache.SqliteMetadataCacheService(legacyDir, new SilentLogger());
        try {
            // The old shape cannot be migrated, and a cache has nothing worth preserving, so the
            // file is thrown away rather than left to fail the boot on every start.
            expect(rebuilt.getReleases("stale")).toBeUndefined();
            expect(rebuilt.getLatestRelease("stale", false)).toBeUndefined();

            rebuilt.setRelease("fresh", "v1.0.0", createRelease("v1.0.0", false), undefined, 60);
            const stored = rebuilt.getReleaseByTag("fresh", "v1.0.0");
            expect(stored !== undefined ? stored.release.tag : undefined).toBe("v1.0.0");
        } finally {
            rebuilt.close();
        }
    });

    it("rebuilds a cache discarded for an unreadable schema, sidecars included", function () {
        const legacyDir = fs.mkdtempSync(path.join(os.tmpdir(), "download-server-sidecar-"));
        const dbPath = path.join(legacyDir, "metadata.db");
        const legacy = new Database(dbPath);
        legacy.exec("CREATE TABLE app_state (app TEXT PRIMARY KEY)");
        legacy.close();
        // A write-ahead log left from the old schema. Replayed against the fresh file it would
        // resurrect rows for tables that no longer exist, so it has to go with the database.
        fs.writeFileSync(dbPath + "-wal", "stale write-ahead log");

        const rebuilt = new metadataCache.SqliteMetadataCacheService(legacyDir, new SilentLogger());
        try {
            // WAL recreates its own sidecars on open, so the check is that nothing replayed:
            // the old app_state row is gone and the cache is usable.
            expect(rebuilt.getReleases("anything")).toBeUndefined();
            rebuilt.setRelease("fresh", "v1.0.0", createRelease("v1.0.0", false), undefined, 60);
            const stored = rebuilt.getReleaseByTag("fresh", "v1.0.0");
            expect(stored !== undefined ? stored.release.tag : undefined).toBe("v1.0.0");
        } finally {
            rebuilt.close();
        }
    });

    it("rethrows an error that is not an unreadable schema", function () {
        const brokenDir = fs.mkdtempSync(path.join(os.tmpdir(), "download-server-broken-"));
        // A directory where the database file belongs: the open itself fails, and swallowing that
        // as "unreadable schema" would delete the operator's directory and retry forever.
        fs.mkdirSync(path.join(brokenDir, "metadata.db"));
        expect(function () {
            const opened = new metadataCache.SqliteMetadataCacheService(brokenDir, new SilentLogger());
            expect(opened).toBeDefined();
        }).toThrow();
    });
});
