import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
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

    it("returns v1 manifest for standard tauri windows target triple", async function () {
        releaseSvc.setRelease(
            helpers.createRelease("v1.1.0", [
                helpers.createAsset("app_x64-setup.exe"),
                helpers.createAsset("app_x64-setup.exe.sig")
            ])
        );
        assetCacheSvc.registerSignature("app_x64-setup.exe", "sig-content");

        const result = await service.getV1Update({
            appId: "app1",
            currentVersion: "v1.0.0",
            target: "x86_64-pc-windows-msvc"
        });

        expect(result.status).toBe(200);
        const manifest = result.body as updaterTypes.TauriV1Manifest;
        expect(manifest.url.indexOf("app_x64-setup.exe") >= 0).toBe(true);
    });

    it("returns v1 manifest for standard tauri apple silicon target triple", async function () {
        releaseSvc.setRelease(
            helpers.createRelease("v1.1.0", [
                helpers.createAsset("app_aarch64.dmg"),
                helpers.createAsset("app_aarch64.dmg.sig")
            ])
        );
        assetCacheSvc.registerSignature("app_aarch64.dmg", "sig-content");

        const result = await service.getV1Update({
            appId: "app1",
            currentVersion: "v1.0.0",
            target: "aarch64-apple-darwin"
        });

        expect(result.status).toBe(200);
        const manifest = result.body as updaterTypes.TauriV1Manifest;
        expect(manifest.url.indexOf("app_aarch64.dmg") >= 0).toBe(true);
    });

    it("returns v1 manifest for standard tauri linux target triple", async function () {
        releaseSvc.setRelease(
            helpers.createRelease("v1.1.0", [
                helpers.createAsset("app_amd64.AppImage"),
                helpers.createAsset("app_amd64.AppImage.sig")
            ])
        );
        assetCacheSvc.registerSignature("app_amd64.AppImage", "sig-content");

        const result = await service.getV1Update({
            appId: "app1",
            currentVersion: "v1.0.0",
            target: "x86_64-unknown-linux-gnu"
        });

        expect(result.status).toBe(200);
        const manifest = result.body as updaterTypes.TauriV1Manifest;
        expect(manifest.url.indexOf("app_amd64.AppImage") >= 0).toBe(true);
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

    it("returns v1 manifest when target is omitted", async function () {
        releaseSvc.setRelease(
            helpers.createRelease("v1.1.0", [
                helpers.createAsset("app-linux-x64.tar.gz"),
                helpers.createAsset("app-linux-x64.tar.gz.sig")
            ])
        );
        assetCacheSvc.registerSignature("app-linux-x64.tar.gz", "sig-content");

        const result = await service.getV1Update({ appId: "app1", currentVersion: "v1.0.0" });

        expect(result.status).toBe(200);
        const manifest = result.body as updaterTypes.TauriV1Manifest;
        expect(manifest.version).toBe("1.1.0");
        expect(manifest.signature).toBe("sig-content");
    });

    it("returns v1 manifest for unknown target os using linux fallback", async function () {
        releaseSvc.setRelease(
            helpers.createRelease("v1.1.0", [
                helpers.createAsset("app-linux-x64.tar.gz"),
                helpers.createAsset("app-linux-x64.tar.gz.sig")
            ])
        );
        assetCacheSvc.registerSignature("app-linux-x64.tar.gz", "sig-content");

        const result = await service.getV1Update({ appId: "app1", currentVersion: "v1.0.0", target: "unknown-x64" });

        expect(result.status).toBe(200);
        const manifest = result.body as updaterTypes.TauriV1Manifest;
        expect(manifest.url.indexOf("app-linux-x64.tar.gz") >= 0).toBe(true);
    });

    it("falls back to x64 arch when target arch is unknown", async function () {
        releaseSvc.setRelease(
            helpers.createRelease("v1.1.0", [
                helpers.createAsset("app-windows-x64.exe"),
                helpers.createAsset("app-windows-x64.exe.sig")
            ])
        );
        assetCacheSvc.registerSignature("app-windows-x64.exe", "sig-content");

        const result = await service.getV1Update({
            appId: "app1",
            currentVersion: "v1.0.0",
            target: "windows-unknown"
        });

        expect(result.status).toBe(200);
        const manifest = result.body as updaterTypes.TauriV1Manifest;
        expect(manifest.url.indexOf("app-windows-x64.exe") >= 0).toBe(true);
    });

    it("returns v1 manifest with empty signature when no signature asset exists", async function () {
        releaseSvc.setRelease(helpers.createRelease("v1.1.0", [helpers.createAsset("app-windows-x64.exe")]));

        const result = await service.getV1Update({ appId: "app1", currentVersion: "v1.0.0", target: "windows-x86_64" });

        expect(result.status).toBe(200);
        const manifest = result.body as updaterTypes.TauriV1Manifest;
        expect(manifest.signature).toBe("");
    });

    it("returns 400 for v1 when target os is undefined", async function () {
        const parseSpy = vi
            .spyOn(
                service as unknown as { parseTauriTarget: (target: string) => { os: undefined; arch: string } },
                "parseTauriTarget"
            )
            .mockReturnValue({ os: undefined, arch: "x64" });
        releaseSvc.setRelease(helpers.createRelease("v1.1.0", [helpers.createAsset("app-windows-x64.exe")]));

        const result = await service.getV1Update({ appId: "app1", currentVersion: "v1.0.0", target: "windows-x86_64" });

        expect(result.status).toBe(400);
        parseSpy.mockRestore();
    });

    it("returns 404 for v2 when no release found", async function () {
        const result = await service.getV2Update({ appId: "app1", currentVersion: "v1.0.0" });

        expect(result.status).toBe(404);
    });

    it("returns 204 for v2 when up to date", async function () {
        releaseSvc.setRelease(helpers.createRelease("v1.0.0", [helpers.createAsset("app-windows-x64.exe")]));

        const result = await service.getV2Update({ appId: "app1", currentVersion: "v1.0.0" });

        expect(result.status).toBe(204);
        expect(result.body).toBeUndefined();
    });
});
