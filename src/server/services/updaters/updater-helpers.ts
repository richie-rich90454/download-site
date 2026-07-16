import * as fs from "node:fs";
import * as types from "../../../shared/types.js";
import * as assetCache from "../../cache/asset-cache.js";
import * as download from "../download-service.js";

export function normalizeVersion(version: string): string {
    const trimmed = version.trim();
    if (trimmed.charAt(0) === "v" || trimmed.charAt(0) === "V") {
        return trimmed.substring(1);
    }
    return trimmed;
}

export function isUpToDate(currentVersion: string | undefined, latestVersion: string): boolean {
    if (currentVersion === undefined || currentVersion.length === 0) {
        return false;
    }
    return normalizeVersion(currentVersion) === normalizeVersion(latestVersion);
}

export function findSignatureAsset(assets: types.Asset[], assetName: string): types.Asset | undefined {
    const sigName = assetName + ".sig";
    for (let i = 0; i < assets.length; i = i + 1) {
        if (assets[i].name === sigName) {
            return assets[i];
        }
    }
    return undefined;
}

export async function readSignature(
    asset: types.Asset,
    cache: assetCache.AssetCacheService,
    appId: string,
    version: string
): Promise<string> {
    const result = await cache.getAssetPath(appId, version, asset);
    const content = fs.readFileSync(result.filePath, "utf8");
    return content.trim();
}

export function buildGenericPlatformKey(os: types.Platform, arch: string): string {
    return os + "_" + arch;
}

export function buildTauriV2PlatformKey(os: types.Platform, arch: string): string {
    const osPart = os === "darwin" ? "darwin" : os;
    const archPart = arch === "arm64" ? "aarch64" : arch === "x64" ? "x86_64" : arch;
    return osPart + "-" + archPart;
}

export function buildAssetUrl(
    downloadService: download.DownloadService,
    appId: string,
    version: string,
    assetName: string
): string {
    return downloadService.buildAssetUrl(appId, version, assetName);
}
