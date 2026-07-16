import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as types from "../../../../src/shared/types.js";
import * as releaseService from "../../../../src/server/services/release-service.js";
import * as downloadService from "../../../../src/server/services/download-service.js";
import * as assetCache from "../../../../src/server/cache/asset-cache.js";

export class MockReleaseService {
    private release: types.Release | undefined;

    setRelease(release: types.Release): void {
        this.release = release;
    }

    async getLatestRelease(): Promise<types.Release | undefined> {
        return this.release;
    }

    async getReleaseByTag(): Promise<types.Release | undefined> {
        return this.release;
    }
}

export class MockDownloadService {
    buildAssetUrl(appId: string, version: string, assetName: string): string {
        return "http://localhost:3000/download/" + appId + "?version=" + version + "&asset=" + assetName;
    }
}

export class MockAssetCache implements assetCache.AssetCacheService {
    private sigDir: string;
    private signatures: Record<string, string> = {};

    constructor() {
        this.sigDir = fs.mkdtempSync(path.join(os.tmpdir(), "download-server-sig-"));
    }

    registerSignature(assetName: string, signature: string): void {
        this.signatures[assetName + ".sig"] = signature;
    }

    async getAssetPath(app: string, version: string, asset: types.Asset): Promise<assetCache.AssetCacheResult> {
        const sigContent = this.signatures[asset.name] || "";
        const filePath = path.join(this.sigDir, app + "_" + version + "_" + asset.name);
        fs.writeFileSync(filePath, sigContent);
        return {
            filePath: filePath,
            cached: true,
            entry: {
                app: app,
                version: version,
                assetName: asset.name,
                filePath: filePath,
                size: sigContent.length,
                checksum: "",
                lastAccessedAt: Date.now(),
                createdAt: Date.now()
            }
        };
    }

    purge(): void {
        // no-op
    }

    close(): void {
        fs.rmSync(this.sigDir, { recursive: true, force: true });
    }
}

export function createRelease(tag: string, assets: types.Asset[]): types.Release {
    return {
        tag: tag,
        name: "Release " + tag,
        notes: "Notes for " + tag,
        publishedAt: "2024-01-01T00:00:00Z",
        prerelease: false,
        assets: assets
    };
}

export function createAsset(name: string): types.Asset {
    return {
        name: name,
        size: 100,
        contentType: "application/octet-stream",
        url: "http://example.com/" + name,
        browserDownloadUrl: "http://example.com/" + name
    };
}

export function asReleaseService(mock: MockReleaseService): releaseService.ReleaseService {
    return mock as unknown as releaseService.ReleaseService;
}

export function asDownloadService(mock: MockDownloadService): downloadService.DownloadService {
    return mock as unknown as downloadService.DownloadService;
}

export function asAssetCache(mock: MockAssetCache): assetCache.AssetCacheService {
    return mock;
}
