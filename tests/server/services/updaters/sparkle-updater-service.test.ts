import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as platform from "../../../../src/server/platform/platform-detector.js";
import * as sparkleUpdater from "../../../../src/server/services/updaters/sparkle-updater-service.js";
import * as helpers from "./test-helpers.js";

describe("SparkleUpdaterService", function () {
    let releaseSvc: helpers.MockReleaseService;
    let downloadSvc: helpers.MockDownloadService;
    let assetCacheSvc: helpers.MockAssetCache;
    let service: sparkleUpdater.SparkleUpdaterService;

    beforeEach(function () {
        releaseSvc = new helpers.MockReleaseService();
        downloadSvc = new helpers.MockDownloadService();
        assetCacheSvc = new helpers.MockAssetCache();
        service = new sparkleUpdater.SparkleUpdaterService(
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
        releaseSvc.setRelease(helpers.createRelease("v1.0.0", [helpers.createAsset("app-macos-universal.dmg")]));

        const result = await service.getAppcast({ appId: "app1", currentVersion: "v1.0.0" });

        expect(result.status).toBe(204);
        expect(result.body).toBeUndefined();
    });

    it("returns appcast XML for macOS", async function () {
        releaseSvc.setRelease(
            helpers.createRelease("v1.1.0", [
                helpers.createAsset("app-macos-universal.dmg"),
                helpers.createAsset("app-macos-universal.dmg.sig")
            ])
        );
        assetCacheSvc.registerSignature("app-macos-universal.dmg", "sparkle-sig");

        const result = await service.getAppcast({ appId: "app1", currentVersion: "v1.0.0" });

        expect(result.status).toBe(200);
        expect(result.contentType).toBe("application/xml");
        const xml = result.body as string;
        expect(xml.indexOf("<rss") >= 0).toBe(true);
        expect(xml.indexOf('sparkle:version="1.1.0"') >= 0).toBe(true);
        expect(xml.indexOf('sparkle:edSignature="sparkle-sig"') >= 0).toBe(true);
    });

    it("escapes XML special characters", async function () {
        const release = helpers.createRelease("v1.1.0", [helpers.createAsset("app-macos-universal.dmg")]);
        release.name = 'Release <special> & "test"';
        releaseSvc.setRelease(release);

        const result = await service.getAppcast({ appId: "app1", currentVersion: "v1.0.0" });

        const xml = result.body as string;
        expect(xml.indexOf("&lt;special&gt;") >= 0).toBe(true);
        expect(xml.indexOf("&quot;test&quot;") >= 0).toBe(true);
    });

    it("returns 404 when no release found", async function () {
        const result = await service.getAppcast({ appId: "app1", currentVersion: "v1.0.0" });

        expect(result.status).toBe(404);
    });

    it("returns 404 when no macOS asset found", async function () {
        releaseSvc.setRelease(helpers.createRelease("v1.1.0", [helpers.createAsset("app-windows-x64.exe")]));

        const result = await service.getAppcast({ appId: "app1", currentVersion: "v1.0.0" });

        expect(result.status).toBe(404);
    });
});
