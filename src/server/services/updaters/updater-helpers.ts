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
    // Asynchronous read: this runs on the request path of every updater poll, and the
    // synchronous variant blocked the event loop for the length of the file.
    return (await fs.promises.readFile(result.filePath, "utf8")).trim();
}

/**
 * Resolves every signature a response needs, concurrently.
 *
 * The previous shape resolved them one at a time inside the per-platform loop, so a release
 * with seven platform assets paid up to seven sequential upstream fetches before it could answer
 * a single updater poll. Collecting the work first and awaiting it together turns that into one
 * round of parallel work.
 *
 * A signature that cannot be read is reported as absent rather than failing the response: an
 * unsigned update is still a usable update, and the humanist thing is to serve it and let the
 * client decide, not to hand back nothing because one auxiliary file is missing.
 */
export async function readSignatures(
    wanted: types.Asset[],
    cache: assetCache.AssetCacheService,
    appId: string,
    version: string
): Promise<Map<string, string>> {
    const result = new Map<string, string>();
    if (wanted.length === 0) {
        return result;
    }
    const reads = wanted.map(async function (asset: types.Asset): Promise<void> {
        try {
            const signature = await readSignature(asset, cache, appId, version);
            if (signature.length > 0) {
                result.set(asset.name, signature);
            }
        } catch {
            // Absent signature: the update is still offered, without a signature attribute.
        }
    });
    await Promise.all(reads);
    return result;
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
