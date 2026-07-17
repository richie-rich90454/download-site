import * as types from "../../../shared/types.js";
import * as platform from "../../platform/platform-detector.js";
import * as release from "../release-service.js";
import * as download from "../download-service.js";
import * as assetCache from "../../cache/asset-cache.js";
import * as helpers from "./updater-helpers.js";
import * as updaterTypes from "./updater-types.js";

export class TauriUpdaterService {
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

    async getV1Update(context: updaterTypes.UpdaterContext): Promise<updaterTypes.UpdaterResult> {
        const releaseObj = await this.releaseService.getLatestRelease(context.appId, false);
        if (releaseObj === undefined) {
            return { status: 404, body: { error: "No release found" } };
        }
        if (helpers.isUpToDate(context.currentVersion, releaseObj.tag)) {
            return { status: 204, body: undefined };
        }
        const target = this.parseTauriTarget(context.target !== undefined ? context.target : "");
        if (target.os === undefined) {
            return { status: 400, body: { error: "Invalid target" } };
        }
        const asset = this.detector.selectAsset(releaseObj.assets, target);
        if (asset === undefined) {
            return { status: 404, body: { error: "No asset for target" } };
        }
        const signature = await this.resolveSignature(releaseObj.assets, asset, context.appId, releaseObj.tag);
        const url = helpers.buildAssetUrl(this.downloadService, context.appId, releaseObj.tag, asset.name);
        const manifest: updaterTypes.TauriV1Manifest = {
            version: helpers.normalizeVersion(releaseObj.tag),
            notes: releaseObj.notes,
            pub_date: releaseObj.publishedAt,
            signature: signature,
            url: url
        };
        return { status: 200, body: manifest };
    }

    async getV2Update(context: updaterTypes.UpdaterContext): Promise<updaterTypes.UpdaterResult> {
        const releaseObj = await this.releaseService.getLatestRelease(context.appId, false);
        if (releaseObj === undefined) {
            return { status: 404, body: { error: "No release found" } };
        }
        if (helpers.isUpToDate(context.currentVersion, releaseObj.tag)) {
            return { status: 204, body: undefined };
        }
        const platforms: Record<string, { signature: string; url: string }> = {};
        const targets = this.listTauriV2Targets();
        for (let i = 0; i < targets.length; i = i + 1) {
            const target = targets[i];
            const asset = this.detector.selectAsset(releaseObj.assets, target);
            if (asset === undefined) {
                continue;
            }
            const signature = await this.resolveSignature(releaseObj.assets, asset, context.appId, releaseObj.tag);
            const url = helpers.buildAssetUrl(this.downloadService, context.appId, releaseObj.tag, asset.name);
            const key = helpers.buildTauriV2PlatformKey(target.os, target.arch);
            platforms[key] = { signature: signature, url: url };
        }
        if (Object.keys(platforms).length === 0) {
            return { status: 404, body: { error: "No assets found" } };
        }
        const manifest: updaterTypes.TauriV2Manifest = {
            version: helpers.normalizeVersion(releaseObj.tag),
            notes: releaseObj.notes,
            pub_date: releaseObj.publishedAt,
            platforms: platforms
        };
        return { status: 200, body: manifest };
    }

    private parseTauriTarget(target: string): types.Target {
        const parts = target.split("-");
        if (parts.length >= 3) {
            const arch = this.detector.normalizeArch(parts[0]) || "x64";
            const os = this.detector.normalizeOs(parts[2]);
            if (os !== undefined) {
                return { os: os, arch: arch };
            }
        }
        const os = this.detector.normalizeOs(parts[0] || "");
        let arch = "x64";
        if (parts.length > 1) {
            const rawArch = parts.slice(1).join("-");
            const normalized = this.detector.normalizeArch(rawArch);
            arch = normalized !== undefined ? normalized : "x64";
        }
        if (os === undefined) {
            return { os: "linux", arch: arch };
        }
        return { os: os, arch: arch };
    }

    private listTauriV2Targets(): types.Target[] {
        return [
            { os: "windows", arch: "x64" },
            { os: "windows", arch: "arm64" },
            { os: "darwin", arch: "x64" },
            { os: "darwin", arch: "arm64" },
            { os: "linux", arch: "x64" },
            { os: "linux", arch: "arm64" }
        ];
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
}
