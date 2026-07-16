import * as config from "../config/config.js";
import * as types from "../../shared/types.js";
import * as githubTypes from "../github/github-types.js";
import * as metadataCache from "../cache/metadata-cache.js";
import * as platform from "../platform/platform-detector.js";
import * as health from "../health/health-service.js";
import * as logger from "../logging/logger.js";

export interface ReleaseFilters {
    page?: number;
    perPage?: number;
    includePrerelease?: boolean;
}

export class ReleaseService {
    private readonly cfg: config.ServerConfig;
    private readonly provider: githubTypes.GitHubProvider;
    private readonly cache: metadataCache.MetadataCacheService;
    private readonly detector: platform.PlatformDetector;
    private readonly healthService: health.HealthService;
    private readonly logger: logger.Logger;
    private readonly defaultTtlSeconds: number;

    constructor(
        cfg: config.ServerConfig,
        provider: githubTypes.GitHubProvider,
        cache: metadataCache.MetadataCacheService,
        detector: platform.PlatformDetector,
        healthService: health.HealthService,
        loggerInstance: logger.Logger
    ) {
        this.cfg = cfg;
        this.provider = provider;
        this.cache = cache;
        this.detector = detector;
        this.healthService = healthService;
        this.logger = loggerInstance;
        this.defaultTtlSeconds = 300;
    }

    async listReleases(appId: string, filters: ReleaseFilters): Promise<types.Release[]> {
        const app = this.findApp(appId);
        const page = filters.page !== undefined ? filters.page : 1;
        const perPage = filters.perPage !== undefined ? filters.perPage : 30;
        const includePrerelease = filters.includePrerelease === true;
        const cached = this.cache.getReleases(appId, { includePrerelease: includePrerelease });
        const now = Date.now();
        if (cached !== undefined && cached.expiresAt > now) {
            this.logger.debug("Release list cache hit", { app: appId, count: cached.releases.length });
            return cached.releases;
        }
        const etag = cached !== undefined ? cached.etag : undefined;
        const result = await this.provider.listReleases(app.repo, { page: page, perPage: perPage, etag: etag });
        if (result.fromCache && cached !== undefined) {
            this.cache.setReleases(appId, cached.releases, etag, this.defaultTtlSeconds);
            return cached.releases;
        }
        const releases = this.transformReleases(result.data);
        this.cache.setReleases(appId, releases, result.etag, this.defaultTtlSeconds);
        this.logger.info("Release list refreshed", { app: appId, count: releases.length });
        if (!includePrerelease) {
            return this.filterPrereleases(releases);
        }
        return releases;
    }

    async getLatestRelease(appId: string, includePrerelease: boolean): Promise<types.Release | undefined> {
        const releases = await this.listReleases(appId, { includePrerelease: includePrerelease });
        if (releases.length === 0) {
            return undefined;
        }
        const sorted = releases.slice(0);
        sorted.sort(function (a, b) {
            const aDate = new Date(a.publishedAt).getTime();
            const bDate = new Date(b.publishedAt).getTime();
            if (aDate > bDate) {
                return -1;
            }
            if (aDate < bDate) {
                return 1;
            }
            return 0;
        });
        return sorted[0];
    }

    async getReleaseByTag(appId: string, tag: string): Promise<types.Release | undefined> {
        const app = this.findApp(appId);
        const cached = this.cache.getReleaseByTag(appId, tag);
        const now = Date.now();
        if (cached !== undefined && cached.expiresAt > now) {
            this.logger.debug("Release by tag cache hit", { app: appId, tag: tag });
            return cached.release;
        }
        const etag = cached !== undefined ? cached.etag : undefined;
        try {
            const result = await this.provider.getReleaseByTag(app.repo, tag);
            if (result.data === undefined) {
                return undefined;
            }
            if (result.fromCache && cached !== undefined) {
                this.cache.setRelease(appId, tag, cached.release, etag, this.defaultTtlSeconds);
                return cached.release;
            }
            const release = this.transformRelease(result.data);
            this.cache.setRelease(appId, tag, release, result.etag, this.defaultTtlSeconds);
            return release;
        } catch (err) {
            if (cached !== undefined) {
                const message = err instanceof Error ? err.message : String(err);
                this.logger.warn("GitHub refresh failed, returning stale release", {
                    app: appId,
                    tag: tag,
                    error: message
                });
                return cached.release;
            }
            throw err;
        }
    }

    async getAssetForTarget(appId: string, tag: string, target: types.Target): Promise<types.Asset | undefined> {
        const release = await this.getReleaseByTag(appId, tag);
        if (release === undefined) {
            return undefined;
        }
        return this.detector.selectAsset(release.assets, target);
    }

    async warmCache(): Promise<void> {
        this.logger.info("Warming metadata cache");
        for (let i = 0; i < this.cfg.apps.length; i = i + 1) {
            const app = this.cfg.apps[i];
            try {
                const result = await this.provider.listReleases(app.repo, { page: 1, perPage: 100 });
                const releases = this.transformReleases(result.data);
                this.cache.setReleases(app.id, releases, result.etag, this.defaultTtlSeconds);
                this.logger.info("Warmed cache for app", { app: app.id, count: releases.length });
            } catch (err) {
                const message = err instanceof Error ? err.message : String(err);
                this.logger.error("Failed to warm cache for app", { app: app.id, error: message });
            }
        }
        this.healthService.markCacheInitialized(true);
        this.logger.info("Metadata cache warming complete");
    }

    private findApp(appId: string): types.App {
        for (let i = 0; i < this.cfg.apps.length; i = i + 1) {
            if (this.cfg.apps[i].id === appId) {
                return this.cfg.apps[i];
            }
        }
        throw new Error("App not found: " + appId);
    }

    private transformReleases(githubReleases: types.GitHubRelease[]): types.Release[] {
        const result: types.Release[] = [];
        for (let i = 0; i < githubReleases.length; i = i + 1) {
            result.push(this.transformRelease(githubReleases[i]));
        }
        return result;
    }

    private transformRelease(githubRelease: types.GitHubRelease | undefined): types.Release {
        if (githubRelease === undefined) {
            throw new Error("GitHub release data is undefined");
        }
        return {
            tag: githubRelease.tag_name,
            name: githubRelease.name,
            notes: githubRelease.body !== null ? githubRelease.body : "",
            publishedAt: githubRelease.published_at,
            prerelease: githubRelease.prerelease,
            assets: this.transformAssets(githubRelease.assets)
        };
    }

    private transformAssets(githubAssets: types.GitHubAsset[]): types.Asset[] {
        const result: types.Asset[] = [];
        for (let i = 0; i < githubAssets.length; i = i + 1) {
            const asset = githubAssets[i];
            result.push({
                name: asset.name,
                size: asset.size,
                contentType: asset.content_type,
                url: asset.url,
                browserDownloadUrl: asset.browser_download_url
            });
        }
        return result;
    }

    private filterPrereleases(releases: types.Release[]): types.Release[] {
        const result: types.Release[] = [];
        for (let i = 0; i < releases.length; i = i + 1) {
            if (!releases[i].prerelease) {
                result.push(releases[i]);
            }
        }
        return result;
    }
}
