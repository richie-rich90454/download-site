import * as fs from "node:fs";
import * as logger from "../logging/logger.js";

export interface HealthService {
    isReady(): boolean;
    isLive(): boolean;
    getHealth(): HealthStatus;
    markCacheInitialized(initialized: boolean): void;
}

export interface HealthStatus {
    status: string;
    ready: boolean;
    live: boolean;
    uptime: number;
    checks: HealthChecks;
}

export interface HealthChecks {
    cacheInitialized: boolean;
    diskSpace: DiskSpaceCheck;
}

export interface DiskSpaceCheck {
    ok: boolean;
    freeBytes: number;
    thresholdBytes: number;
}

export class DefaultHealthService implements HealthService {
    private readonly cacheDir: string;
    private readonly logger: logger.Logger;
    private readonly startTime: number;
    private readonly diskSpaceThresholdBytes: number;
    private cacheInitialized: boolean;

    constructor(cacheDir: string, loggerInstance: logger.Logger) {
        this.cacheDir = cacheDir;
        this.logger = loggerInstance;
        this.startTime = Date.now();
        this.diskSpaceThresholdBytes = 100 * 1024 * 1024;
        this.cacheInitialized = false;
    }

    isReady(): boolean {
        const diskCheck = this.checkDiskSpace();
        return this.cacheInitialized && diskCheck.ok;
    }

    isLive(): boolean {
        return true;
    }

    getHealth(): HealthStatus {
        const diskCheck = this.checkDiskSpace();
        const ready = this.cacheInitialized && diskCheck.ok;
        return {
            status: ready ? "healthy" : "unhealthy",
            ready: ready,
            live: true,
            uptime: Date.now() - this.startTime,
            checks: {
                cacheInitialized: this.cacheInitialized,
                diskSpace: diskCheck
            }
        };
    }

    markCacheInitialized(initialized: boolean): void {
        this.cacheInitialized = initialized;
        this.logger.info("Cache initialization state changed", { initialized: initialized });
    }

    private checkDiskSpace(): DiskSpaceCheck {
        try {
            const stats = fs.statfsSync(this.cacheDir);
            const freeBytes = stats.bavail * stats.bsize;
            return {
                ok: freeBytes >= this.diskSpaceThresholdBytes,
                freeBytes: freeBytes,
                thresholdBytes: this.diskSpaceThresholdBytes
            };
        } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            this.logger.warn("Failed to check disk space", { error: message });
            return {
                ok: false,
                freeBytes: 0,
                thresholdBytes: this.diskSpaceThresholdBytes
            };
        }
    }
}
