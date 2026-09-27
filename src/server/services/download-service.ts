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
import * as apiError from "../http/api-error.js";
import * as egress from "../http/egress.js";

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
            throw apiError.Errors.releaseNotFound();
        }
        let asset: types.Asset | undefined;
        if (options.assetName !== undefined && options.assetName.length > 0) {
            asset = this.findAssetByName(releaseObj.assets, options.assetName);
        } else {
            const target = this.detector.detectTarget(options.userAgent, options.platformHint);
            asset = this.detector.selectAsset(releaseObj.assets, target);
        }
        if (asset === undefined) {
            throw apiError.Errors.assetNotFound();
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

    /**
     * Serves a cached file, honouring conditional and range requests.
     *
     * Conditional handling is the point of the extra parameters. A download is re-fetched on every
     * page visit and on every updater poll; without an ETag each of those pulls the whole file
     * again, which for a 90 MB installer is the single largest avoidable cost on the server.
     * With one, the client revalidates and gets a 304.
     */
    serveFile(
        filePath: string,
        assetName: string,
        reply: ReplyLike,
        rangeHeader?: string,
        checksum?: string,
        ifNoneMatch?: string,
        ifModifiedSince?: string
    ): void {
        const stat = fs.statSync(filePath);
        const totalSize = stat.size;
        const contentType = this.getContentType(assetName);
        const safeName = this.safeFilename(assetName);
        const etag = this.etagFor(checksum, stat);
        const lastModified = new Date(stat.mtimeMs).toUTCString();
        if (isFastifyReply(reply)) {
            reply.hijack();
        }
        const res = isFastifyReply(reply) ? reply.raw : reply;
        const headers: Record<string, string> = {
            "Content-Type": contentType,
            "Content-Disposition": 'attachment; filename="' + safeName + '"',
            "Cache-Control": "public, max-age=31536000, immutable",
            "Accept-Ranges": "bytes",
            ETag: etag,
            "Last-Modified": lastModified
        };
        if (checksum !== undefined && checksum.length > 0) {
            headers["X-Checksum-SHA256"] = checksum;
        }

        if (this.isNotModified(etag, lastModified, ifNoneMatch, ifModifiedSince)) {
            res.statusCode = 304;
            const notModifiedKeys = Object.keys(headers);
            for (let i = 0; i < notModifiedKeys.length; i += 1) {
                res.setHeader(notModifiedKeys[i], headers[notModifiedKeys[i]]);
            }
            // A 304 carries no body. Content-Length would describe a body that is not being sent,
            // and a client is entitled to treat that as a protocol error.
            res.removeHeader("Content-Length");
            res.end();
            return;
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

    /**
     * A strong validator for the file.
     *
     * The SHA-256 we already computed at download time is the ideal ETag: it identifies the content
     * exactly, not the particular copy of it. Falling back to size and mtime covers a row written
     * before the checksum was known, and is the same validator @fastify/send would have produced.
     */
    private etagFor(checksum: string | undefined, stat: fs.Stats): string {
        if (checksum !== undefined && checksum.length > 0) {
            return '"' + checksum + '"';
        }
        return '"' + stat.size.toString(16) + "-" + Math.trunc(stat.mtimeMs).toString(16) + '"';
    }

    /**
     * Whether the client already holds this exact file.
     *
     * `If-None-Match` wins over `If-Modified-Since` when both are sent, which is what RFC 9110
     * requires. The date comparison is second-resolution and the ETag is not, so a file modified
     * inside the same second as the client's copy is only caught by the ETag - which is why the
     * date is a fallback rather than the check.
     */
    private isNotModified(
        etag: string,
        lastModified: string,
        ifNoneMatch: string | undefined,
        ifModifiedSince: string | undefined
    ): boolean {
        if (ifNoneMatch !== undefined && ifNoneMatch.length > 0) {
            if (ifNoneMatch.trim() === "*") {
                return true;
            }
            const candidates = ifNoneMatch.split(",");
            for (let i = 0; i < candidates.length; i += 1) {
                const candidate = candidates[i].trim();
                if (candidate === etag || candidate === "W/" + etag) {
                    return true;
                }
            }
            return false;
        }
        if (ifModifiedSince !== undefined && ifModifiedSince.length > 0) {
            const since = Date.parse(ifModifiedSince);
            // Both sides in milliseconds. The header is second-resolution and the file's mtime is
            // not, so the comparison stays strict: a file rewritten inside the client's cached
            // second is older than the client's copy only in appearance, and the ETag catches it.
            const modifiedAt = new Date(lastModified).getTime();
            if (!isNaN(since) && !isNaN(modifiedAt) && since >= modifiedAt) {
                return true;
            }
        }
        return false;
    }

    async proxyDownload(
        appId: string,
        asset: types.Asset,
        release: types.Release,
        reply: ReplyLike,
        rangeHeader?: string,
        requestId?: string
    ): Promise<void> {
        const url = asset.browserDownloadUrl;
        const requestHeaders: Record<string, string> = {};
        if (rangeHeader !== undefined && rangeHeader.length > 0) {
            requestHeaders.Range = rangeHeader;
        }
        const controller = new AbortController();
        try {
            const response = await this.fetchAsset(url, controller.signal, requestHeaders);
            if (response.statusCode < 200 || response.statusCode >= 300 || response.body === null) {
                if (isFastifyReply(reply)) {
                    // The upstream status is logged, not returned: a 404 from GitHub can mean a
                    // private repository, which would otherwise confirm its existence.
                    this.logger.warn("Upstream asset request rejected", {
                        app: appId,
                        version: release.tag,
                        asset: asset.name,
                        upstreamStatus: response.statusCode
                    });
                    const upstream = apiError.Errors.upstreamUnavailable();
                    reply
                        .status(upstream.status)
                        .send(apiError.toClientError(upstream, requestId !== undefined ? requestId : "unknown"));
                } else {
                    reply.statusCode = 502;
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
                // The underlying error can name internal hosts, so it is logged and dropped.
                const upstream = apiError.Errors.upstreamUnavailable();
                reply
                    .status(upstream.status)
                    .send(apiError.toClientError(upstream, requestId !== undefined ? requestId : "unknown"));
            } else {
                reply.statusCode = 502;
                reply.end();
            }
        } finally {
            // The timeout is owned by the shared egress client, which aborts the same signal.
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
        headers?: Record<string, string>
    ): Promise<undici.Dispatcher.ResponseData> {
        return egress.requestAsset(url, { signal: signal, headers: headers });
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
