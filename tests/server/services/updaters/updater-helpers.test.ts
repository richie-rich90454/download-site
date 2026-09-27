import { describe, it, expect } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as helpers from "../../../../src/server/services/updaters/updater-helpers.js";
import * as assetCache from "../../../../src/server/cache/asset-cache.js";
import * as types from "../../../../src/shared/types.js";

/** Minimal asset cache over a temp directory, with an opt-in failing read. */
class TestAssetCache {
    private readonly dir: string;
    private shouldFail = false;

    constructor() {
        this.dir = fs.mkdtempSync(path.join(os.tmpdir(), "download-server-sigtest-"));
    }

    stubFailure(): void {
        this.shouldFail = true;
    }

    adapter(): assetCache.AssetCacheService {
        const self = this;
        return {
            getAssetPath: function (): Promise<assetCache.AssetCacheResult> {
                if (self.shouldFail) {
                    return Promise.reject(new Error("simulated read failure"));
                }
                const filePath = path.join(self.dir, "payload");
                fs.writeFileSync(filePath, "  signature-bytes  ");
                const entry: assetCache.AssetCacheEntry = {
                    app: "app1",
                    version: "v1.0.0",
                    assetName: "app.exe.sig",
                    filePath: filePath,
                    size: 17,
                    checksum: "abc",
                    lastAccessedAt: 0,
                    createdAt: 0
                };
                return Promise.resolve({ filePath: filePath, cached: true, entry: entry });
            },
            getChecksum: function (): string | undefined {
                return undefined;
            },
            getStats: function (): assetCache.AssetCacheStats {
                return { totalSize: 0, totalCount: 0 };
            },
            purge: function (): void {
                // no-op
            },
            close: function (): void {
                // no-op
            }
        };
    }

    close(): void {
        fs.rmSync(this.dir, { recursive: true, force: true });
    }
}

describe("updater-helpers", function () {
    it("normalizes version with v prefix", function () {
        expect(helpers.normalizeVersion("v1.0.0")).toBe("1.0.0");
    });

    it("normalizes version with V prefix", function () {
        expect(helpers.normalizeVersion("V1.0.0")).toBe("1.0.0");
    });

    it("trims whitespace from version", function () {
        expect(helpers.normalizeVersion("  1.0.0  ")).toBe("1.0.0");
    });

    it("returns empty string for whitespace only version", function () {
        expect(helpers.normalizeVersion("   ")).toBe("");
    });

    it("returns false for undefined current version", function () {
        expect(helpers.isUpToDate(undefined, "v1.0.0")).toBe(false);
    });

    it("returns false for empty current version", function () {
        expect(helpers.isUpToDate("", "v1.0.0")).toBe(false);
    });

    it("returns true when normalized versions match", function () {
        expect(helpers.isUpToDate("v1.0.0", "1.0.0")).toBe(true);
    });

    it("returns false when versions differ", function () {
        expect(helpers.isUpToDate("v1.0.0", "v1.1.0")).toBe(false);
    });

    it("finds signature asset by name", function () {
        const assets: types.Asset[] = [
            {
                name: "app.exe",
                size: 100,
                contentType: "application/octet-stream",
                url: "http://example.com/app.exe",
                browserDownloadUrl: "http://example.com/app.exe"
            },
            {
                name: "app.exe.sig",
                size: 10,
                contentType: "application/octet-stream",
                url: "http://example.com/app.exe.sig",
                browserDownloadUrl: "http://example.com/app.exe.sig"
            }
        ];

        const sig = helpers.findSignatureAsset(assets, "app.exe");

        expect(sig).toBeDefined();
        expect(sig.name).toBe("app.exe.sig");
    });

    it("returns undefined when signature asset is missing", function () {
        const assets: types.Asset[] = [
            {
                name: "app.exe",
                size: 100,
                contentType: "application/octet-stream",
                url: "http://example.com/app.exe",
                browserDownloadUrl: "http://example.com/app.exe"
            }
        ];

        const sig = helpers.findSignatureAsset(assets, "app.exe");

        expect(sig).toBeUndefined();
    });

    it("builds generic platform key", function () {
        expect(helpers.buildGenericPlatformKey("windows", "x64")).toBe("windows_x64");
    });

    it("builds tauri v2 platform key for darwin", function () {
        expect(helpers.buildTauriV2PlatformKey("darwin", "arm64")).toBe("darwin-aarch64");
    });

    it("builds tauri v2 platform key for linux x64", function () {
        expect(helpers.buildTauriV2PlatformKey("linux", "x64")).toBe("linux-x86_64");
    });

    it("builds tauri v2 platform key for other architectures", function () {
        expect(helpers.buildTauriV2PlatformKey("windows", "x86")).toBe("windows-x86");
    });

    describe("version precedence", function () {
        it("treats a short tag as the version it abbreviates", function () {
            // The bug this replaces: string equality made a client already on 1.2.0 look stale
            // against a tag of 1.2, so it was told to reinstall forever.
            expect(helpers.isUpToDate("1.2.0", "v1.2")).toBe(true);
            expect(helpers.isUpToDate("v1.2.0", "1.2")).toBe(true);
            expect(helpers.isUpToDate("1.2.0", "v1.2.0")).toBe(true);
        });

        it("orders a patch above a short tag of the same minor", function () {
            expect(helpers.isUpToDate("1.2.0", "v1.2")).toBe(true);
            expect(helpers.isUpToDate("1.1.9", "v1.2")).toBe(false);
        });

        it("does not push a stable client onto a prerelease of the same version", function () {
            expect(helpers.isUpToDate("1.0.0", "v1.0.0-rc.1")).toBe(true);
        });

        it("offers a newer prerelease to an older prerelease", function () {
            expect(helpers.isUpToDate("1.0.0-rc.1", "v1.0.0-rc.2")).toBe(false);
        });

        it("orders two-digit identifiers numerically, not lexically", function () {
            // Lexical comparison gets this backwards: "9" sorts after "10" as text.
            expect(helpers.isUpToDate("1.0.9", "v1.0.10")).toBe(false);
            expect(helpers.isUpToDate("1.0.10", "v1.0.9")).toBe(true);
        });

        it("falls back to exact comparison when a version is not readable", function () {
            expect(helpers.isUpToDate("nightly-20240101", "nightly-20240101")).toBe(true);
            expect(helpers.isUpToDate("nightly-20240101", "nightly-20240102")).toBe(false);
        });

        it("offers an update when the latest version is unrecognisable", function () {
            expect(helpers.isUpToDate("1.0.0", "not-a-version")).toBe(false);
        });
    });

    describe("toComparable", function () {
        it("reads a strict version with a leading v", function () {
            expect(helpers.toComparable("v1.2.3")).toBeDefined();
        });

        it("coerces a short form", function () {
            const coerced = helpers.toComparable("1.2");
            expect(coerced).toBeDefined();
            expect(coerced !== undefined ? coerced.version : "").toBe("1.2.0");
        });

        it("returns undefined for text that is not a version", function () {
            expect(helpers.toComparable("nightly")).toBeUndefined();
        });

        it("returns undefined for an empty string", function () {
            expect(helpers.toComparable("")).toBeUndefined();
        });
    });

    describe("readSignatures", function () {
        it("returns an empty map when nothing is wanted", async function () {
            const cache = new TestAssetCache();
            const cacheAdapter = cache.adapter();

            const result = await helpers.readSignatures([], cacheAdapter, "app1", "v1.0.0");

            expect(result.size).toBe(0);
            cache.close();
        });

        it("skips a signature that cannot be read instead of failing the response", async function () {
            const cache = new TestAssetCache();
            const wanted: types.Asset[] = [
                {
                    name: "app.exe.sig",
                    size: 4,
                    contentType: "application/octet-stream",
                    url: "https://github.com/app.exe.sig",
                    browserDownloadUrl: "https://github.com/app.exe.sig"
                }
            ];
            const cacheAdapter = cache.adapter();
            cache.stubFailure();

            const result = await helpers.readSignatures(wanted, cacheAdapter, "app1", "v1.0.0");

            // An unsigned update is still a usable update; the client gets to decide.
            expect(result.size).toBe(0);
            cache.close();
        });
    });
});
