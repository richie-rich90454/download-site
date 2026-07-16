import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as platform from "../../../../src/server/platform/platform-detector.js";
import * as genericUpdater from "../../../../src/server/services/updaters/generic-updater-service.js";
import * as updaterTypes from "../../../../src/server/services/updaters/updater-types.js";
import * as helpers from "./test-helpers.js";

describe("GenericUpdaterService", function () {
    let releaseSvc: helpers.MockReleaseService;
    let downloadSvc: helpers.MockDownloadService;
    let assetCacheSvc: helpers.MockAssetCache;
    let service: genericUpdater.GenericUpdaterService;

    beforeEach(function () {
        releaseSvc = new helpers.MockReleaseService();
        downloadSvc = new helpers.MockDownloadService();
        assetCacheSvc = new helpers.MockAssetCache();
        service = new genericUpdater.GenericUpdaterService(
            helpers.asReleaseService(releaseSvc),
            helpers.asDownloadService(downloadSvc),
            helpers.asAssetCache(assetCacheSvc),
            new platform.DefaultPlatformDetector()
        );
    });

    afterEach(function () {
        assetCacheSvc.close();
    });

    it("returns 204 when up to date", async function () {
        releaseSvc.setRelease(helpers.createRelease("v1.0.0", [helpers.createAsset("app-windows-x64.exe")]));

        const result = await service.getUpdate({ appId: "app1", currentVersion: "v1.0.0" });

        expect(result.status).toBe(204);
        expect(result.body).toBeUndefined();
    });

    it("returns generic JSON manifest", async function () {
        releaseSvc.setRelease(
            helpers.createRelease("v1.1.0", [
                helpers.createAsset("app-windows-x64.exe"),
                helpers.createAsset("app-windows-x64.exe.sig"),
                helpers.createAsset("app-linux-x64.AppImage"),
                helpers.createAsset("app-linux-x64.AppImage.sig")
            ])
        );
        assetCacheSvc.registerSignature("app-windows-x64.exe", "win-sig");
        assetCacheSvc.registerSignature("app-linux-x64.AppImage", "linux-sig");

        const result = await service.getUpdate({ appId: "app1", currentVersion: "v1.0.0" });

        expect(result.status).toBe(200);
        const manifest = result.body as updaterTypes.GenericUpdateManifest;
        expect(manifest.version).toBe("1.1.0");
        expect(Object.keys(manifest.platforms).length >= 2).toBe(true);
        expect(manifest.platforms["windows_x64"].signature).toBe("win-sig");
    });

    it("returns 404 when no release found", async function () {
        const result = await service.getUpdate({ appId: "app1", currentVersion: "v1.0.0" });

        expect(result.status).toBe(404);
    });

    it("returns 404 when no assets found", async function () {
        releaseSvc.setRelease(helpers.createRelease("v1.1.0", []));

        const result = await service.getUpdate({ appId: "app1", currentVersion: "v1.0.0" });

        expect(result.status).toBe(404);
    });

    it("returns manifest with empty signature when signature asset is missing", async function () {
        releaseSvc.setRelease(helpers.createRelease("v1.1.0", [helpers.createAsset("app-windows-x86.exe")]));

        const result = await service.getUpdate({ appId: "app1", currentVersion: "v1.0.0" });

        expect(result.status).toBe(200);
        const manifest = result.body as updaterTypes.GenericUpdateManifest;
        expect(manifest.platforms["windows_x86"].signature).toBe("");
    });
});
