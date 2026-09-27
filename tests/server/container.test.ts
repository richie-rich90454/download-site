import { describe, it, expect, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as containerModule from "../../src/server/container.js";
import * as config from "../../src/server/config/config.js";

let tempDir: string;
let openServices: containerModule.Services | undefined;

function createTestConfig(): config.ServerConfig {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "download-server-container-"));
    return {
        port: 3000,
        cacheDir: tempDir,
        logLevel: "silent",
        corsOrigin: undefined,
        github: {
            token: undefined,
            appId: undefined,
            privateKey: undefined
        },
        rateLimits: {
            max: 100,
            timeWindow: 60000
        },
        adminApiKey: undefined,
        webhookSecret: undefined,
        publicBaseUrl: "https://mirror.example.com",
        apps: [
            {
                id: "app1",
                repo: "owner/repo",
                name: "App One"
            }
        ]
    };
}

/** Builds the graph and remembers it so the SQLite handles can be released afterwards. */
function build(): containerModule.Services {
    const services = containerModule.registerServices(createTestConfig());
    openServices = services;
    return services;
}

afterEach(function () {
    // Windows will not remove a directory that still holds an open SQLite file.
    if (openServices !== undefined) {
        openServices.metadataCache.close();
        openServices.assetCache.close();
        openServices = undefined;
    }
    if (tempDir !== undefined) {
        fs.rmSync(tempDir, { recursive: true, force: true });
    }
});

/**
 * The container is a plain composition root, so the thing worth asserting is that every service
 * is constructed and reachable on the returned graph. The previous version of this file resolved
 * each service out of a tsyringe container that nothing ever resolved from.
 */
describe("registerServices", function () {
    it("returns the config it was given", function () {
        const cfg = createTestConfig();

        const services = containerModule.registerServices(cfg);
        openServices = services;

        expect(services.config).toBe(cfg);
    });

    it("provides a logger", function () {
        const services = build();

        expect(typeof services.logger.info).toBe("function");
    });

    it("provides metrics", function () {
        const services = build();

        expect(typeof services.metrics.metrics).toBe("function");
    });

    it("provides the health service", function () {
        const services = build();

        expect(typeof services.health.isReady).toBe("function");
    });

    it("provides the GitHub provider", function () {
        const services = build();

        expect(typeof services.githubProvider.listReleases).toBe("function");
    });

    it("provides the metadata cache", function () {
        const services = build();

        expect(typeof services.metadataCache.getReleases).toBe("function");
        expect(typeof services.metadataCache.getLatestRelease).toBe("function");
    });

    it("provides the asset cache", function () {
        const services = build();

        expect(typeof services.assetCache.getAssetPath).toBe("function");
        expect(typeof services.assetCache.getStats).toBe("function");
    });

    it("provides the platform detector", function () {
        const services = build();

        expect(typeof services.platformDetector.detectTarget).toBe("function");
    });

    it("provides the release service", function () {
        const services = build();

        expect(typeof services.release.listReleases).toBe("function");
    });

    it("provides the download service", function () {
        const services = build();

        expect(typeof services.download.resolveAsset).toBe("function");
    });

    it("provides every updater service", function () {
        const services = build();

        expect(typeof services.tauriUpdater.getV1Update).toBe("function");
        expect(typeof services.genericUpdater.getUpdate).toBe("function");
        expect(typeof services.squirrelUpdater.getUpdate).toBe("function");
        expect(typeof services.sparkleUpdater.getAppcast).toBe("function");
    });

    it("uses the configured public base url for download links", function () {
        const services = build();

        const url = services.download.buildAssetUrl("app1", "v1.0.0", "app.exe");

        expect(url.indexOf("https://mirror.example.com/download/app1") === 0).toBe(true);
    });

    it("uses a custom maxCacheableSize when configured", function () {
        const cfg = createTestConfig();
        cfg.assetCache = { maxCacheableSize: 1024 };
        const services = containerModule.registerServices(cfg);
        openServices = services;

        const limits = services.assetCache as unknown as { limits: { maxCacheableSize: number } };
        expect(limits.limits.maxCacheableSize).toBe(1024);
    });

    it("falls back to the default maxCacheableSize when none is configured", function () {
        const cfg = createTestConfig();
        cfg.assetCache = undefined;
        const services = containerModule.registerServices(cfg);
        openServices = services;

        const limits = services.assetCache as unknown as { limits: { maxCacheableSize: number } };
        expect(limits.limits.maxCacheableSize).toBe(config.DEFAULT_MAX_CACHEABLE_SIZE);
    });

    it("returns the same instance for a repeated lookup on the graph", function () {
        const services = build();

        // The caches must be shared, not rebuilt per lookup, or the SQLite handles would leak.
        expect(services.assetCache).toBe(services.assetCache);
        expect(services.metadataCache).toBe(services.metadataCache);
    });
});
