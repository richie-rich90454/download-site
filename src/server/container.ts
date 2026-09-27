import * as config from "./config/config.js";
import * as pinoLogger from "./logging/pino-logger.js";
import * as logger from "./logging/logger.js";
import * as metrics from "./telemetry/metrics.js";
import * as health from "./health/health-service.js";
import * as githubProvider from "./github/github-provider.js";
import * as githubTypes from "./github/github-types.js";
import * as metadataCache from "./cache/metadata-cache.js";
import * as assetCache from "./cache/asset-cache.js";
import * as platform from "./platform/platform-detector.js";
import * as releaseService from "./services/release-service.js";
import * as downloadService from "./services/download-service.js";
import * as tauriUpdater from "./services/updaters/tauri-updater-service.js";
import * as genericUpdater from "./services/updaters/generic-updater-service.js";
import * as squirrelUpdater from "./services/updaters/squirrel-updater-service.js";
import * as sparkleUpdater from "./services/updaters/sparkle-updater-service.js";

export interface Services {
    config: config.ServerConfig;
    logger: logger.Logger;
    metrics: metrics.MetricsService;
    health: health.HealthService;
    githubProvider: githubTypes.GitHubProvider;
    metadataCache: metadataCache.MetadataCacheService;
    assetCache: assetCache.AssetCacheService;
    platformDetector: platform.PlatformDetector;
    release: releaseService.ReleaseService;
    download: downloadService.DownloadService;
    tauriUpdater: tauriUpdater.TauriUpdaterService;
    genericUpdater: genericUpdater.GenericUpdaterService;
    squirrelUpdater: squirrelUpdater.SquirrelUpdaterService;
    sparkleUpdater: sparkleUpdater.SparkleUpdaterService;
}

export function registerServices(cfg: config.ServerConfig): Services {
    const logger = new pinoLogger.PinoLogger(cfg.logLevel);

    const metricsService = new metrics.MetricsService();

    const healthService = new health.DefaultHealthService(cfg.cacheDir, logger);

    const provider = new githubProvider.GitHubProvider(
        cfg.github.token,
        cfg.github.appId,
        cfg.github.privateKey,
        logger,
        metricsService
    );

    const cache = new metadataCache.SqliteMetadataCacheService(cfg.cacheDir, logger);

    const maxCacheableSize =
        cfg.assetCache !== undefined && cfg.assetCache.maxCacheableSize !== undefined
            ? cfg.assetCache.maxCacheableSize
            : config.DEFAULT_MAX_CACHEABLE_SIZE;
    const assetCacheLimits: assetCache.AssetCacheLimits = {
        maxSize: 10 * 1024 * 1024 * 1024,
        maxCount: 1000,
        maxAgeMs: 7 * 24 * 60 * 60 * 1000,
        maxCacheableSize: maxCacheableSize
    };
    const assetCacheService = new assetCache.DiskAssetCacheService(
        cfg.cacheDir,
        logger,
        metricsService,
        assetCacheLimits
    );

    const detector = new platform.DefaultPlatformDetector();

    const releaseSvc = new releaseService.ReleaseService(
        cfg,
        provider,
        cache,
        assetCacheService,
        detector,
        healthService,
        logger
    );

    // Absolute download URLs in every updater response and the Sparkle appcast are built from
    // this. It used to be hardcoded to http://localhost:<port>, so no real client could use them.
    const baseUrl = cfg.publicBaseUrl;
    const downloadSvc = new downloadService.DownloadService(
        releaseSvc,
        assetCacheService,
        detector,
        metricsService,
        logger,
        baseUrl,
        assetCacheLimits
    );

    const tauriSvc = new tauriUpdater.TauriUpdaterService(releaseSvc, downloadSvc, assetCacheService, detector);

    const genericSvc = new genericUpdater.GenericUpdaterService(releaseSvc, downloadSvc, assetCacheService, detector);

    const squirrelSvc = new squirrelUpdater.SquirrelUpdaterService(releaseSvc, downloadSvc, detector);

    const sparkleSvc = new sparkleUpdater.SparkleUpdaterService(releaseSvc, downloadSvc, assetCacheService, detector);

    return {
        config: cfg,
        logger: logger,
        metrics: metricsService,
        health: healthService,
        githubProvider: provider,
        metadataCache: cache,
        assetCache: assetCacheService,
        platformDetector: detector,
        release: releaseSvc,
        download: downloadSvc,
        tauriUpdater: tauriSvc,
        genericUpdater: genericSvc,
        squirrelUpdater: squirrelSvc,
        sparkleUpdater: sparkleSvc
    };
}
