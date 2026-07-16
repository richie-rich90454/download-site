import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as health from "../../../src/server/health/health-service.js";
import { SilentLogger } from "../test-helpers.js";

describe("DefaultHealthService", function () {
    let tempDir: string;
    let logger: SilentLogger;

    beforeEach(function () {
        tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "download-server-health-"));
        logger = new SilentLogger();
    });

    afterEach(function () {
        fs.rmSync(tempDir, { recursive: true, force: true });
    });

    it("reports not ready before cache initialization", function () {
        const service = new health.DefaultHealthService(tempDir, logger);

        expect(service.isReady()).toBe(false);
    });

    it("reports live as true", function () {
        const service = new health.DefaultHealthService(tempDir, logger);

        expect(service.isLive()).toBe(true);
    });

    it("reports ready after cache initialization", function () {
        const service = new health.DefaultHealthService(tempDir, logger);

        service.markCacheInitialized(true);

        expect(service.isReady()).toBe(true);
    });

    it("returns health status with uptime and checks", function () {
        const service = new health.DefaultHealthService(tempDir, logger);

        service.markCacheInitialized(true);
        const status = service.getHealth();

        expect(status.status).toBe("healthy");
        expect(status.ready).toBe(true);
        expect(status.live).toBe(true);
        expect(status.uptime >= 0).toBe(true);
        expect(status.checks.cacheInitialized).toBe(true);
        expect(status.checks.diskSpace.ok).toBe(true);
        expect(status.checks.diskSpace.freeBytes > 0).toBe(true);
    });

    it("reports unhealthy when cache is not initialized", function () {
        const service = new health.DefaultHealthService(tempDir, logger);

        const status = service.getHealth();

        expect(status.status).toBe("unhealthy");
        expect(status.ready).toBe(false);
    });

    it("includes disk space check", function () {
        const service = new health.DefaultHealthService(tempDir, logger);

        service.markCacheInitialized(true);
        const status = service.getHealth();

        expect(status.checks.diskSpace.thresholdBytes).toBe(100 * 1024 * 1024);
        expect(status.checks.diskSpace.ok).toBe(true);
    });

    it("returns unhealthy disk check when statfs fails", function () {
        const nonExistentDir = path.join(tempDir, "does-not-exist");
        const service = new health.DefaultHealthService(nonExistentDir, logger);

        service.markCacheInitialized(true);
        const status = service.getHealth();

        expect(status.checks.diskSpace.ok).toBe(false);
        expect(status.checks.diskSpace.freeBytes).toBe(0);
        expect(status.ready).toBe(false);
    });
});
