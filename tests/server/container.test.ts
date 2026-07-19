import { describe, it, expect, beforeEach } from "vitest";
import "reflect-metadata";
import * as containerModule from "../../src/server/container.js";
import * as config from "../../src/server/config/config.js";

function createTestConfig(): config.ServerConfig {
    return {
        port: 3000,
        cacheDir: "/tmp/cache",
        logLevel: "silent",
        github: {
            token: undefined,
            appId: undefined,
            privateKey: undefined
        },
        rateLimits: {
            max: 100,
            timeWindow: 60000
        },
        apps: [
            {
                id: "app1",
                repo: "owner/repo",
                name: "App One"
            }
        ]
    };
}

describe("container", function () {
    beforeEach(function () {
        containerModule.container.reset();
    });

    it("registers and resolves ServerConfig singleton", function () {
        const cfg = createTestConfig();
        containerModule.registerServices(cfg);

        const resolved = containerModule.container.resolve("ServerConfig");
        expect(resolved.port).toBe(cfg.port);
        expect(resolved.cacheDir).toBe(cfg.cacheDir);
    });

    it("registers and resolves Logger singleton", function () {
        const cfg = createTestConfig();
        containerModule.registerServices(cfg);

        const resolved = containerModule.container.resolve("Logger");
        expect(resolved).toBeDefined();
        expect(typeof resolved.info).toBe("function");
    });

    it("returns the same logger instance on repeated resolves", function () {
        const cfg = createTestConfig();
        containerModule.registerServices(cfg);

        const first = containerModule.container.resolve("Logger");
        const second = containerModule.container.resolve("Logger");
        expect(first).toBe(second);
    });

    it("registers MetricsService singleton", function () {
        const cfg = createTestConfig();
        containerModule.registerServices(cfg);

        const resolved = containerModule.container.resolve("MetricsService");
        expect(resolved).toBeDefined();
        expect(typeof resolved.metrics).toBe("function");
    });

    it("registers TelemetryService singleton", function () {
        const cfg = createTestConfig();
        containerModule.registerServices(cfg);

        const resolved = containerModule.container.resolve("TelemetryService");
        expect(resolved).toBeDefined();
        expect(typeof resolved.getTracer).toBe("function");
    });

    it("registers HealthService singleton", function () {
        const cfg = createTestConfig();
        containerModule.registerServices(cfg);

        const resolved = containerModule.container.resolve("HealthService");
        expect(resolved).toBeDefined();
        expect(typeof resolved.isReady).toBe("function");
    });

    it("registers GitHubProvider singleton", function () {
        const cfg = createTestConfig();
        containerModule.registerServices(cfg);

        const resolved = containerModule.container.resolve("GitHubProvider");
        expect(resolved).toBeDefined();
        expect(typeof resolved.listReleases).toBe("function");
    });

    it("registers MetadataCacheService singleton", function () {
        const cfg = createTestConfig();
        containerModule.registerServices(cfg);

        const resolved = containerModule.container.resolve("MetadataCacheService");
        expect(resolved).toBeDefined();
        expect(typeof resolved.getReleases).toBe("function");
    });

    it("registers AssetCacheService singleton", function () {
        const cfg = createTestConfig();
        containerModule.registerServices(cfg);

        const resolved = containerModule.container.resolve("AssetCacheService");
        expect(resolved).toBeDefined();
        expect(typeof resolved.getAssetPath).toBe("function");
    });

    it("uses custom maxCacheableSize when configured", function () {
        const cfg = createTestConfig();
        cfg.assetCache = { maxCacheableSize: 1024 };
        const services = containerModule.registerServices(cfg);

        const limits = services.assetCache as unknown as { limits: { maxCacheableSize: number } };
        expect(limits.limits.maxCacheableSize).toBe(1024);
    });

    it("registers PlatformDetector singleton", function () {
        const cfg = createTestConfig();
        containerModule.registerServices(cfg);

        const resolved = containerModule.container.resolve("PlatformDetector");
        expect(resolved).toBeDefined();
        expect(typeof resolved.detectTarget).toBe("function");
    });

    it("registers ReleaseService singleton", function () {
        const cfg = createTestConfig();
        containerModule.registerServices(cfg);

        const resolved = containerModule.container.resolve("ReleaseService");
        expect(resolved).toBeDefined();
        expect(typeof resolved.listReleases).toBe("function");
    });

    it("registers DownloadService singleton", function () {
        const cfg = createTestConfig();
        containerModule.registerServices(cfg);

        const resolved = containerModule.container.resolve("DownloadService");
        expect(resolved).toBeDefined();
        expect(typeof resolved.resolveAsset).toBe("function");
    });

    it("registers TauriUpdaterService singleton", function () {
        const cfg = createTestConfig();
        containerModule.registerServices(cfg);

        const resolved = containerModule.container.resolve("TauriUpdaterService");
        expect(resolved).toBeDefined();
        expect(typeof resolved.getV1Update).toBe("function");
    });

    it("registers GenericUpdaterService singleton", function () {
        const cfg = createTestConfig();
        containerModule.registerServices(cfg);

        const resolved = containerModule.container.resolve("GenericUpdaterService");
        expect(resolved).toBeDefined();
        expect(typeof resolved.getUpdate).toBe("function");
    });

    it("registers SquirrelUpdaterService singleton", function () {
        const cfg = createTestConfig();
        containerModule.registerServices(cfg);

        const resolved = containerModule.container.resolve("SquirrelUpdaterService");
        expect(resolved).toBeDefined();
        expect(typeof resolved.getUpdate).toBe("function");
    });

    it("registers SparkleUpdaterService singleton", function () {
        const cfg = createTestConfig();
        containerModule.registerServices(cfg);

        const resolved = containerModule.container.resolve("SparkleUpdaterService");
        expect(resolved).toBeDefined();
        expect(typeof resolved.getAppcast).toBe("function");
    });
});
