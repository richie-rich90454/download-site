import * as fs from "node:fs";
import * as http from "node:http";
import type { FastifyReply } from "fastify";
import * as path from "node:path";
import * as undici from "undici";
import * as types from "../../shared/types.js";
import * as assetCache from "../cache/asset-cache.js";
import * as platform from "../platform/platform-detector.js";
import * as release from "./release-service.js";
import * as metrics from "../telemetry/metrics.js";
import * as logger from "../logging/logger.js";

type ReplyLike = FastifyReply | http.ServerResponse;

function isFastifyReply(reply: ReplyLike): reply is FastifyReply {
    return "hijack" in reply && typeof reply.hijack === "function";
}

export interface DownloadResult {
    filePath?: string;
    asset: types.Asset;
    release: types.Release;
    proxied: boolean;
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
    private readonly limits: assetCache.AssetCacheLimits;

    constructor(
        releaseService: release.ReleaseService,
        assetCacheService: assetCache.AssetCacheService,
        detector: platform.PlatformDetector,
        metricsInstance: metrics.MetricsService,
        loggerInstance: logger.Logger,
        baseUrl: string,
        limits?: assetCache.AssetCacheLimits
    ) {
        this.releaseService = releaseService;
        this.assetCache = assetCacheService;
        this.detector = detector;
        this.metrics = metricsInstance;
        this.logger = loggerInstance;
        this.baseUrl = baseUrl;
        if (limits !== undefined) {
            this.limits = limits;
        } else {
            this.limits = {
                maxSize: 10 * 1024 * 1024 * 1024,
                maxCount: 1000,
                maxAgeMs: 7 * 24 * 60 * 60 * 1000,
                maxCacheableSize: 10 * 1024 * 1024 * 1024
            };
        }
        if (this.limits.maxCacheableSize === undefined) {
            this.limits.maxCacheableSize = 10 * 1024 * 1024 * 1024;
        }
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
        const maxCacheableSize = this.limits.maxCacheableSize as number;
        if (asset.size > maxCacheableSize) {
            this.logger.info("Asset exceeds cacheable size, proxying", {
                app: appId,
                version: releaseObj.tag,
                asset: asset.name,
                size: asset.size,
                maxCacheableSize: maxCacheableSize
            });
            return { asset: asset, release: releaseObj, proxied: true };
        }
        const cacheResult = await this.assetCache.getAssetPath(appId, releaseObj.tag, asset);
        this.logger.info("Asset resolved", {
            app: appId,
            version: releaseObj.tag,
            asset: asset.name,
            cached: cacheResult.cached
        });
        return { filePath: cacheResult.filePath, asset: asset, release: releaseObj, proxied: false };
    }

    serveFile(filePath: string, assetName: string, reply: ReplyLike, rangeHeader?: string, checksum?: string): void {
        const stat = fs.statSync(filePath);
        const totalSize = stat.size;
        const contentType = this.getContentType(assetName);
        const safeName = this.safeFilename(assetName);
        if (isFastifyReply(reply)) {
            reply.hijack();
        }
        const res = isFastifyReply(reply) ? reply.raw : reply;
        const headers: Record<string, string> = {
            "Content-Type": contentType,
            "Content-Disposition": 'attachment; filename="' + safeName + '"',
            "Cache-Control": "public, max-age=31536000, immutable",
            "Accept-Ranges": "bytes"
        };
        if (checksum !== undefined && checksum.length > 0) {
            headers["X-Checksum-SHA256"] = checksum;
        }
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
        stream.on("error", function (err) {
            self.logger.error("File stream error", { path: filePath, error: err.message });
            if (!res.writableEnded) {
                res.destroy();
            }
        });
        stream.pipe(res);
    }

    async proxyDownload(
        appId: string,
        asset: types.Asset,
        release: types.Release,
        reply: ReplyLike,
        rangeHeader?: string
    ): Promise<void> {
        const url = asset.browserDownloadUrl;
        const requestHeaders: Record<string, string> = {};
        if (rangeHeader !== undefined && rangeHeader.length > 0) {
            requestHeaders.Range = rangeHeader;
        }
        const controller = new AbortController();
        const timeout = setTimeout(function () {
            controller.abort();
        }, 300000);
        try {
            const response = await this.fetchAsset(url, controller.signal, undefined, requestHeaders);
            if (response.statusCode < 200 || response.statusCode >= 300 || response.body === null) {
                const status = response.statusCode < 200 || response.statusCode >= 300 ? response.statusCode : 502;
                if (isFastifyReply(reply)) {
                    reply.status(status).send({
                        error: {
                            code: "PROXY_ERROR",
                            message: "Upstream download returned status " + status
                        }
                    });
                } else {
                    reply.statusCode = status;
                    reply.end();
                }
                return;
            }
            if (isFastifyReply(reply)) {
                reply.hijack();
            }
            const res = isFastifyReply(reply) ? reply.raw : reply;
            const contentType = asset.contentType.length > 0 ? asset.contentType : this.getContentType(asset.name);
            const headers: Record<string, string | string[]> = {
                "Content-Type": contentType,
                "Content-Disposition": 'attachment; filename="' + this.safeFilename(asset.name) + '"',
                "Accept-Ranges": "bytes"
            };
            if (response.headers["content-length"] !== undefined) {
                headers["Content-Length"] = response.headers["content-length"];
            }
            if (response.headers["content-range"] !== undefined) {
                headers["Content-Range"] = response.headers["content-range"];
            }
            const keys = Object.keys(headers);
            for (let i = 0; i < keys.length; i = i + 1) {
                res.setHeader(keys[i], headers[keys[i]]);
            }
            res.statusCode = response.statusCode;
            const body = response.body;
            const self = this;
            let bytesSent = 0;
            body.on("data", function (chunk) {
                bytesSent = bytesSent + (chunk as Buffer).length;
            });
            body.on("end", function () {
                self.logger.info("Asset proxied", {
                    app: appId,
                    version: release.tag,
                    asset: asset.name,
                    url: url,
                    bytes: bytesSent
                });
            });
            body.on("error", function (err) {
                self.logger.error("Proxy stream error", { url: url, error: err.message });
                if (!res.writableEnded) {
                    res.destroy();
                }
            });
            body.pipe(res);
            this.metrics.recordProxiedDownload(appId, release.tag, asset.size);
            this.metrics.recordProxyBytesSaved(appId, release.tag, asset.size);
        } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            this.logger.error("Proxy download failed", {
                app: appId,
                version: release.tag,
                asset: asset.name,
                error: message
            });
            if (isFastifyReply(reply)) {
                reply.status(502).send({
                    error: {
                        code: "PROXY_ERROR",
                        message: message
                    }
                });
            } else {
                reply.statusCode = 502;
                reply.end();
            }
        } finally {
            clearTimeout(timeout);
        }
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

    private async fetchAsset(
        url: string,
        signal: AbortSignal,
        redirects?: number,
        headers?: Record<string, string>
    ): Promise<Awaited<ReturnType<typeof undici.request>>> {
        const redirectCount = redirects === undefined ? 0 : redirects;
        const response = await undici.request(url, {
            method: "GET",
            signal: signal,
            headers: headers
        });
        if (response.statusCode >= 300 && response.statusCode < 400 && response.headers.location !== undefined) {
            if (redirectCount >= 5) {
                throw new Error("Asset download redirect limit exceeded");
            }
            const location = Array.isArray(response.headers.location)
                ? response.headers.location[0]
                : response.headers.location;
            return this.fetchAsset(location, signal, redirectCount + 1, headers);
        }
        return response;
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
