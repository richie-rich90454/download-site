import { describe, it, expect } from "vitest";
import * as helpers from "../../../../src/server/services/updaters/updater-helpers.js";
import * as types from "../../../../src/shared/types.js";

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
});
