import "reflect-metadata";
import * as tsyringe from "tsyringe";
import * as config from "./config/config.js";
import * as pinoLogger from "./logging/pino-logger.js";
import * as logger from "./logging/logger.js";
import * as metrics from "./telemetry/metrics.js";
import * as tracing from "./telemetry/tracing.js";
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

export const container = tsyringe.container;

export interface Services {
    config: config.ServerConfig;
    logger: logger.Logger;
    metrics: metrics.MetricsService;
    telemetry: tracing.TelemetryService;
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
    container.registerInstance("ServerConfig", cfg);
    container.registerInstance("Logger", logger);

    const metricsService = new metrics.MetricsService();
    container.registerInstance("MetricsService", metricsService);

    const telemetryService = new tracing.TelemetryService();
    container.registerInstance("TelemetryService", telemetryService);

    const healthService = new health.DefaultHealthService(cfg.cacheDir, logger);
    container.registerInstance("HealthService", healthService);

    const provider = new githubProvider.GitHubProvider(
        cfg.github.token,
        cfg.github.appId,
        cfg.github.privateKey,
        logger,
        metricsService
    );
    container.registerInstance("GitHubProvider", provider);

    const cache = new metadataCache.SqliteMetadataCacheService(cfg.cacheDir, logger);
    container.registerInstance("MetadataCacheService", cache);

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
    container.registerInstance("AssetCacheService", assetCacheService);

    const detector = new platform.DefaultPlatformDetector();
    container.registerInstance("PlatformDetector", detector);

    const releaseSvc = new releaseService.ReleaseService(
        cfg,
        provider,
        cache,
        assetCacheService,
        detector,
        healthService,
        logger
    );
    container.registerInstance("ReleaseService", releaseSvc);

    const baseUrl = "http://localhost:" + cfg.port;
    const downloadSvc = new downloadService.DownloadService(
        releaseSvc,
        assetCacheService,
        detector,
        metricsService,
        logger,
        baseUrl,
        assetCacheLimits
    );
    container.registerInstance("DownloadService", downloadSvc);

    const tauriSvc = new tauriUpdater.TauriUpdaterService(releaseSvc, downloadSvc, assetCacheService, detector);
    container.registerInstance("TauriUpdaterService", tauriSvc);

    const genericSvc = new genericUpdater.GenericUpdaterService(releaseSvc, downloadSvc, assetCacheService, detector);
    container.registerInstance("GenericUpdaterService", genericSvc);

    const squirrelSvc = new squirrelUpdater.SquirrelUpdaterService(releaseSvc, downloadSvc, detector);
    container.registerInstance("SquirrelUpdaterService", squirrelSvc);

    const sparkleSvc = new sparkleUpdater.SparkleUpdaterService(releaseSvc, downloadSvc, assetCacheService, detector);
    container.registerInstance("SparkleUpdaterService", sparkleSvc);

    return {
        config: cfg,
        logger: logger,
        metrics: metricsService,
        telemetry: telemetryService,
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
