import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as platform from "../../../../src/server/platform/platform-detector.js";
import * as tauriUpdater from "../../../../src/server/services/updaters/tauri-updater-service.js";
import * as updaterTypes from "../../../../src/server/services/updaters/updater-types.js";
import * as helpers from "./test-helpers.js";

describe("TauriUpdaterService", function () {
    let releaseSvc: helpers.MockReleaseService;
    let downloadSvc: helpers.MockDownloadService;
    let assetCacheSvc: helpers.MockAssetCache;
    let service: tauriUpdater.TauriUpdaterService;

    beforeEach(function () {
        releaseSvc = new helpers.MockReleaseService();
        downloadSvc = new helpers.MockDownloadService();
        assetCacheSvc = new helpers.MockAssetCache();
        service = new tauriUpdater.TauriUpdaterService(
            helpers.asReleaseService(releaseSvc),
            helpers.asDownloadService(downloadSvc),
            helpers.asAssetCache(assetCacheSvc),
            new platform.DefaultPlatformDetector()
        );
    });

    afterEach(function () {
        assetCacheSvc.close();
    });

    it("returns 204 when current version equals latest", async function () {
        releaseSvc.setRelease(helpers.createRelease("v1.0.0", [helpers.createAsset("app-windows-x64.exe")]));

        const result = await service.getV1Update({ appId: "app1", currentVersion: "v1.0.0", target: "windows-x86_64" });

        expect(result.status).toBe(204);
        expect(result.body).toBeUndefined();
    });

    it("returns v1 manifest for windows", async function () {
        releaseSvc.setRelease(
            helpers.createRelease("v1.1.0", [
                helpers.createAsset("app-windows-x64.exe"),
                helpers.createAsset("app-windows-x64.exe.sig")
            ])
        );
        assetCacheSvc.registerSignature("app-windows-x64.exe", "sig-content");

        const result = await service.getV1Update({ appId: "app1", currentVersion: "v1.0.0", target: "windows-x86_64" });

        expect(result.status).toBe(200);
        const manifest = result.body as updaterTypes.TauriV1Manifest;
        expect(manifest.version).toBe("1.1.0");
        expect(manifest.signature).toBe("sig-content");
        expect(manifest.url.indexOf("app-windows-x64.exe") >= 0).toBe(true);
    });

    it("returns 404 when no release found", async function () {
        const result = await service.getV1Update({ appId: "app1", currentVersion: "v1.0.0", target: "windows-x86_64" });

        expect(result.status).toBe(404);
    });

    it("returns 404 when no asset for target", async function () {
        releaseSvc.setRelease(helpers.createRelease("v1.1.0", [helpers.createAsset("app-macos.dmg")]));

        const result = await service.getV1Update({ appId: "app1", currentVersion: "v1.0.0", target: "windows-x86_64" });

        expect(result.status).toBe(404);
    });

    it("returns v2 manifest with multiple platforms", async function () {
        releaseSvc.setRelease(
            helpers.createRelease("v1.1.0", [
                helpers.createAsset("app-windows-x64.exe"),
                helpers.createAsset("app-windows-x64.exe.sig"),
                helpers.createAsset("app-macos-universal.dmg"),
                helpers.createAsset("app-macos-universal.dmg.sig")
            ])
        );
        assetCacheSvc.registerSignature("app-windows-x64.exe", "win-sig");
        assetCacheSvc.registerSignature("app-macos-universal.dmg", "mac-sig");

        const result = await service.getV2Update({ appId: "app1", currentVersion: "v1.0.0" });

        expect(result.status).toBe(200);
        const manifest = result.body as updaterTypes.TauriV2Manifest;
        expect(manifest.version).toBe("1.1.0");
        expect(Object.keys(manifest.platforms).length >= 2).toBe(true);
        expect(manifest.platforms["windows-x86_64"].signature).toBe("win-sig");
    });

    it("returns 404 for v2 when no assets found", async function () {
        releaseSvc.setRelease(helpers.createRelease("v1.1.0", []));

        const result = await service.getV2Update({ appId: "app1", currentVersion: "v1.0.0" });

        expect(result.status).toBe(404);
    });
});
