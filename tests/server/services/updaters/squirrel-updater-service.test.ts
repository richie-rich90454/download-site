import { describe, it, expect, beforeEach } from "vitest";
import * as platform from "../../../../src/server/platform/platform-detector.js";
import * as squirrelUpdater from "../../../../src/server/services/updaters/squirrel-updater-service.js";
import * as updaterTypes from "../../../../src/server/services/updaters/updater-types.js";
import * as helpers from "./test-helpers.js";

describe("SquirrelUpdaterService", function () {
    let releaseSvc: helpers.MockReleaseService;
    let downloadSvc: helpers.MockDownloadService;
    let service: squirrelUpdater.SquirrelUpdaterService;

    beforeEach(function () {
        releaseSvc = new helpers.MockReleaseService();
        downloadSvc = new helpers.MockDownloadService();
        service = new squirrelUpdater.SquirrelUpdaterService(
            helpers.asReleaseService(releaseSvc),
            helpers.asDownloadService(downloadSvc),
            new platform.DefaultPlatformDetector()
        );
    });

    it("returns 204 when up to date", async function () {
        releaseSvc.setRelease(helpers.createRelease("v1.0.0", [helpers.createAsset("app-windows-x64.exe")]));

        const result = await service.getUpdate({ appId: "app1", currentVersion: "v1.0.0" });

        expect(result.status).toBe(204);
        expect(result.body).toBeUndefined();
    });

    it("returns Squirrel manifest for windows", async function () {
        releaseSvc.setRelease(helpers.createRelease("v1.1.0", [helpers.createAsset("app-windows-x64.exe")]));

        const result = await service.getUpdate({ appId: "app1", currentVersion: "v1.0.0" });

        expect(result.status).toBe(200);
        const manifest = result.body as updaterTypes.SquirrelManifest;
        expect(manifest.url.indexOf("app-windows-x64.exe") >= 0).toBe(true);
        expect(manifest.name).toBe("Release v1.1.0");
    });

    it("returns 404 when no release found", async function () {
        const result = await service.getUpdate({ appId: "app1", currentVersion: "v1.0.0" });

        expect(result.status).toBe(404);
    });

    it("returns 404 when no windows asset found", async function () {
        releaseSvc.setRelease(helpers.createRelease("v1.1.0", [helpers.createAsset("app-macos.dmg")]));

        const result = await service.getUpdate({ appId: "app1", currentVersion: "v1.0.0" });

        expect(result.status).toBe(404);
    });
});
