import * as types from "../../../shared/types.js";
import * as platform from "../../platform/platform-detector.js";
import * as release from "../release-service.js";
import * as download from "../download-service.js";
import * as assetCache from "../../cache/asset-cache.js";
import * as helpers from "./updater-helpers.js";
import * as updaterTypes from "./updater-types.js";

export class SparkleUpdaterService {
    private readonly releaseService: release.ReleaseService;
    private readonly downloadService: download.DownloadService;
    private readonly assetCache: assetCache.AssetCacheService;
    private readonly detector: platform.PlatformDetector;

    constructor(
        releaseService: release.ReleaseService,
        downloadService: download.DownloadService,
        assetCacheService: assetCache.AssetCacheService,
        detector: platform.PlatformDetector
    ) {
        this.releaseService = releaseService;
        this.downloadService = downloadService;
        this.assetCache = assetCacheService;
        this.detector = detector;
    }

    async getAppcast(context: updaterTypes.UpdaterContext): Promise<updaterTypes.UpdaterResult> {
        const releaseObj = await this.releaseService.getLatestRelease(context.appId, false);
        if (releaseObj === undefined) {
            return { status: 404, body: { error: "No release found" } };
        }
        if (helpers.isUpToDate(context.currentVersion, releaseObj.tag)) {
            return { status: 204, body: undefined };
        }
        const targets = [
            { os: "darwin" as types.Platform, arch: "x64" },
            { os: "darwin" as types.Platform, arch: "arm64" }
        ];
        let enclosureXml = "";
        for (let i = 0; i < targets.length; i = i + 1) {
            const target = targets[i];
            const asset = this.detector.selectAsset(releaseObj.assets, target);
            if (asset === undefined) {
                continue;
            }
            const url = helpers.buildAssetUrl(this.downloadService, context.appId, releaseObj.tag, asset.name);
            const signature = await this.resolveSignature(releaseObj.assets, asset, context.appId, releaseObj.tag);
            const osAttr = target.arch === "arm64" ? "macos-arm64" : "macos";
            const sigAttr = signature.length > 0 ? ' sparkle:edSignature="' + this.escapeXml(signature) + '"' : "";
            enclosureXml =
                enclosureXml +
                '<enclosure url="' +
                this.escapeXml(url) +
                '" sparkle:version="' +
                this.escapeXml(helpers.normalizeVersion(releaseObj.tag)) +
                '" sparkle:os="' +
                osAttr +
                '" length="' +
                asset.size +
                '" type="' +
                asset.contentType +
                '"' +
                sigAttr +
                " />\n";
        }
        if (enclosureXml.length === 0) {
            return { status: 404, body: { error: "No macOS asset found" } };
        }
        const pubDate = new Date(releaseObj.publishedAt).toUTCString();
        const xml =
            '<?xml version="1.0" encoding="utf-8"?>\n' +
            '<rss version="2.0" xmlns:sparkle="http://www.andymatuschak.org/xml-namespaces/sparkle" xmlns:dc="http://purl.org/dc/elements/1.1/">\n' +
            "<channel>\n" +
            "<title>" +
            this.escapeXml(context.appId) +
            " Updates</title>\n" +
            "<item>\n" +
            "<title>" +
            this.escapeXml(releaseObj.name) +
            "</title>\n" +
            "<description><![CDATA[" +
            releaseObj.notes +
            "]]></description>\n" +
            "<pubDate>" +
            this.escapeXml(pubDate) +
            "</pubDate>\n" +
            enclosureXml +
            "</item>\n" +
            "</channel>\n" +
            "</rss>";
        return { status: 200, body: xml, contentType: "application/xml" };
    }

    private async resolveSignature(
        assets: types.Asset[],
        asset: types.Asset,
        appId: string,
        version: string
    ): Promise<string> {
        const sigAsset = helpers.findSignatureAsset(assets, asset.name);
        if (sigAsset === undefined) {
            return "";
        }
        return helpers.readSignature(sigAsset, this.assetCache, appId, version);
    }

    private escapeXml(input: string): string {
        return input
            .replace(/&/g, "&amp;")
            .replace(/</g, "&lt;")
            .replace(/>/g, "&gt;")
            .replace(/"/g, "&quot;")
            .replace(/'/g, "&apos;");
    }
}
