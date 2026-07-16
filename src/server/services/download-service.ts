import * as fs from "node:fs";
import * as http from "node:http";
import * as path from "node:path";
import * as types from "../../shared/types.js";
import * as assetCache from "../cache/asset-cache.js";
import * as platform from "../platform/platform-detector.js";
import * as release from "./release-service.js";
import * as metrics from "../telemetry/metrics.js";
import * as logger from "../logging/logger.js";

export interface DownloadResult {
    filePath: string;
    asset: types.Asset;
    release: types.Release;
}

export interface DownloadOptions {
    version?: string;
    assetName?: string;
    userAgent?: string;
    platformHint?: string;
}

export class DownloadService {
    private readonly releaseService: release.ReleaseService;
    private readonly assetCache: assetCache.AssetCacheService;
    private readonly detector: platform.PlatformDetector;
    private readonly metrics: metrics.MetricsService;
    private readonly logger: logger.Logger;
    private readonly baseUrl: string;

    constructor(
        releaseService: release.ReleaseService,
        assetCacheService: assetCache.AssetCacheService,
        detector: platform.PlatformDetector,
        metricsInstance: metrics.MetricsService,
        loggerInstance: logger.Logger,
        baseUrl: string
    ) {
        this.releaseService = releaseService;
        this.assetCache = assetCacheService;
        this.detector = detector;
        this.metrics = metricsInstance;
        this.logger = loggerInstance;
        this.baseUrl = baseUrl;
    }

    async resolveAsset(appId: string, options: DownloadOptions): Promise<DownloadResult> {
        const version = options.version !== undefined && options.version.length > 0 ? options.version : "latest";
        let releaseObj: types.Release | undefined;
        if (version === "latest") {
            releaseObj = await this.releaseService.getLatestRelease(appId, false);
        } else {
            releaseObj = await this.releaseService.getReleaseByTag(appId, version);
        }
        if (releaseObj === undefined) {
            throw new Error("Release not found for app " + appId);
        }
        let asset: types.Asset | undefined;
        if (options.assetName !== undefined && options.assetName.length > 0) {
            asset = this.findAssetByName(releaseObj.assets, options.assetName);
        } else {
            const target = this.detector.detectTarget(options.userAgent, options.platformHint);
            asset = this.detector.selectAsset(releaseObj.assets, target);
        }
        if (asset === undefined) {
            throw new Error("No matching asset found for app " + appId);
        }
        const cacheResult = await this.assetCache.getAssetPath(appId, releaseObj.tag, asset);
        this.logger.info("Asset resolved", {
            app: appId,
            version: releaseObj.tag,
            asset: asset.name,
            cached: cacheResult.cached
        });
        return { filePath: cacheResult.filePath, asset: asset, release: releaseObj };
    }

    serveFile(filePath: string, assetName: string, res: http.ServerResponse, rangeHeader?: string): void {
        const stat = fs.statSync(filePath);
        const totalSize = stat.size;
        const contentType = this.getContentType(assetName);
        const safeName = this.safeFilename(assetName);
        const headers: Record<string, string> = {
            "Content-Type": contentType,
            "Content-Disposition": 'attachment; filename="' + safeName + '"',
            "Cache-Control": "public, max-age=31536000, immutable",
            "Accept-Ranges": "bytes"
        };
        let start = 0;
        let end = totalSize - 1;
        let status = 200;
        if (rangeHeader !== undefined && rangeHeader.length > 0 && rangeHeader.indexOf("bytes=") === 0) {
            const range = this.parseRange(rangeHeader, totalSize);
            if (range === undefined) {
                res.statusCode = 416;
                res.setHeader("Content-Range", "bytes */" + totalSize);
                res.end();
                return;
            }
            start = range.start;
            end = range.end;
            status = 206;
            headers["Content-Range"] = "bytes " + start + "-" + end + "/" + totalSize;
            headers["Content-Length"] = String(end - start + 1);
        } else {
            headers["Content-Length"] = String(totalSize);
        }
        const keys = Object.keys(headers);
        for (let i = 0; i < keys.length; i = i + 1) {
            res.setHeader(keys[i], headers[keys[i]]);
        }
        res.statusCode = status;
        const stream = fs.createReadStream(filePath, { start: start, end: end });
        const self = this;
        let bytesSent = 0;
        stream.on("data", function (chunk) {
            bytesSent = bytesSent + (chunk as Buffer).length;
        });
        stream.on("end", function () {
            self.logger.info("File served", { path: filePath, bytes: bytesSent });
        });
        stream.pipe(res);
    }

    buildAssetUrl(appId: string, version: string, assetName: string): string {
        return (
            this.baseUrl +
            "/download/" +
            appId +
            "?version=" +
            encodeURIComponent(version) +
            "&asset=" +
            encodeURIComponent(assetName)
        );
    }

    private findAssetByName(assets: types.Asset[], name: string): types.Asset | undefined {
        for (let i = 0; i < assets.length; i = i + 1) {
            if (assets[i].name === name) {
                return assets[i];
            }
        }
        return undefined;
    }

    private parseRange(rangeHeader: string, totalSize: number): { start: number; end: number } | undefined {
        const rangeValue = rangeHeader.substring(6);
        const dashIndex = rangeValue.indexOf("-");
        if (dashIndex < 0) {
            return undefined;
        }
        const startStr = rangeValue.substring(0, dashIndex);
        const endStr = rangeValue.substring(dashIndex + 1);
        let start = 0;
        let end = totalSize - 1;
        if (startStr.length > 0) {
            start = Number(startStr);
        }
        if (endStr.length > 0) {
            end = Number(endStr);
        }
        if (isNaN(start) || isNaN(end) || start < 0 || end >= totalSize || start > end) {
            return undefined;
        }
        return { start: start, end: end };
    }

    private getContentType(assetName: string): string {
        const ext = path.extname(assetName).toLowerCase();
        const map: Record<string, string> = {
            ".exe": "application/vnd.microsoft.portable-executable",
            ".msi": "application/x-msi",
            ".dmg": "application/x-apple-diskimage",
            ".pkg": "application/vnd.apple.installer+xml",
            ".zip": "application/zip",
            ".tar": "application/x-tar",
            ".gz": "application/gzip",
            ".tgz": "application/gzip",
            ".deb": "application/vnd.debian.binary-package",
            ".rpm": "application/x-rpm",
            ".appimage": "application/x-executable",
            ".sig": "application/octet-stream"
        };
        if (ext.length > 0 && map[ext] !== undefined) {
            return map[ext];
        }
        if (assetName.indexOf(".tar.gz") >= 0) {
            return "application/gzip";
        }
        return "application/octet-stream";
    }

    private safeFilename(name: string): string {
        return name.replace(/[^a-zA-Z0-9._-]/g, "_");
    }
}
