import { describe, it, expect } from "vitest";
import * as metrics from "../../../src/server/telemetry/metrics.js";

describe("MetricsService", function () {
    it("initializes counters and histograms", function () {
        const service = new metrics.MetricsService();

        expect(service.registry).toBeDefined();
        expect(service.httpRequestsTotal).toBeDefined();
        expect(service.httpRequestDurationSeconds).toBeDefined();
        expect(service.cacheHitsTotal).toBeDefined();
        expect(service.cacheMissesTotal).toBeDefined();
        expect(service.downloadBytesTotal).toBeDefined();
        expect(service.githubApiCallsTotal).toBeDefined();
        expect(service.githubApiDurationSeconds).toBeDefined();
    });

    it("records HTTP request metrics", async function () {
        const service = new metrics.MetricsService();

        service.recordHttpRequest("GET", "/api/releases/app1", 200, 0.123);

        const output = await service.metrics();
        expect(output.indexOf("http_requests_total") >= 0).toBe(true);
        expect(output.indexOf('method="GET"') >= 0).toBe(true);
        expect(output.indexOf('route="/api/releases/app1"') >= 0).toBe(true);
        expect(output.indexOf('status="200"') >= 0).toBe(true);
    });

    it("records cache hit and miss", async function () {
        const service = new metrics.MetricsService();

        service.recordCacheHit("metadata");
        service.recordCacheMiss("asset");

        const output = await service.metrics();
        expect(output.indexOf("cache_hits_total") >= 0).toBe(true);
        expect(output.indexOf("cache_misses_total") >= 0).toBe(true);
    });

    it("records download bytes", async function () {
        const service = new metrics.MetricsService();

        service.recordDownloadBytes("app1", "v1.0.0", 1024);

        const output = await service.metrics();
        expect(output.indexOf("download_bytes_total") >= 0).toBe(true);
    });

    it("records GitHub API call and duration", async function () {
        const service = new metrics.MetricsService();

        service.recordGitHubApiCall("GET", 200);
        service.recordGitHubApiDuration("GET", 0.5);

        const output = await service.metrics();
        expect(output.indexOf("github_api_calls_total") >= 0).toBe(true);
        expect(output.indexOf("github_api_duration_seconds") >= 0).toBe(true);
    });

    it("returns metrics in Prometheus text format", async function () {
        const service = new metrics.MetricsService();

        const output = await service.metrics();

        expect(output.indexOf("# HELP") >= 0 || output.indexOf("# TYPE") >= 0).toBe(true);
    });
});
