import * as prom from "prom-client";

export class MetricsService {
    readonly registry: prom.Registry;
    readonly httpRequestsTotal: prom.Counter;
    readonly httpRequestDurationSeconds: prom.Histogram;
    readonly cacheHitsTotal: prom.Counter;
    readonly cacheMissesTotal: prom.Counter;
    readonly downloadBytesTotal: prom.Counter;
    readonly githubApiCallsTotal: prom.Counter;
    readonly githubApiDurationSeconds: prom.Histogram;

    constructor() {
        this.registry = new prom.Registry();
        this.registry.setDefaultLabels({ service: "download-server" });
        prom.collectDefaultMetrics({ register: this.registry });

        this.httpRequestsTotal = new prom.Counter({
            name: "http_requests_total",
            help: "Total HTTP requests",
            labelNames: ["method", "route", "status"],
            registers: [this.registry]
        });

        this.httpRequestDurationSeconds = new prom.Histogram({
            name: "http_request_duration_seconds",
            help: "HTTP request duration in seconds",
            labelNames: ["method", "route"],
            buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
            registers: [this.registry]
        });

        this.cacheHitsTotal = new prom.Counter({
            name: "cache_hits_total",
            help: "Total cache hits",
            labelNames: ["cache"],
            registers: [this.registry]
        });

        this.cacheMissesTotal = new prom.Counter({
            name: "cache_misses_total",
            help: "Total cache misses",
            labelNames: ["cache"],
            registers: [this.registry]
        });

        this.downloadBytesTotal = new prom.Counter({
            name: "download_bytes_total",
            help: "Total downloaded bytes",
            labelNames: ["app", "version"],
            registers: [this.registry]
        });

        this.githubApiCallsTotal = new prom.Counter({
            name: "github_api_calls_total",
            help: "Total GitHub API calls",
            labelNames: ["method", "status"],
            registers: [this.registry]
        });

        this.githubApiDurationSeconds = new prom.Histogram({
            name: "github_api_duration_seconds",
            help: "GitHub API call duration in seconds",
            labelNames: ["method"],
            buckets: [0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
            registers: [this.registry]
        });
    }

    recordHttpRequest(method: string, route: string, status: number, durationSeconds: number): void {
        this.httpRequestsTotal.inc({ method: method, route: route, status: String(status) });
        this.httpRequestDurationSeconds.observe({ method: method, route: route }, durationSeconds);
    }

    recordCacheHit(cache: string): void {
        this.cacheHitsTotal.inc({ cache: cache });
    }

    recordCacheMiss(cache: string): void {
        this.cacheMissesTotal.inc({ cache: cache });
    }

    recordDownloadBytes(app: string, version: string, bytes: number): void {
        this.downloadBytesTotal.inc({ app: app, version: version }, bytes);
    }

    recordGitHubApiCall(method: string, status: number): void {
        this.githubApiCallsTotal.inc({ method: method, status: String(status) });
    }

    recordGitHubApiDuration(method: string, durationSeconds: number): void {
        this.githubApiDurationSeconds.observe({ method: method }, durationSeconds);
    }

    async metrics(): Promise<string> {
        return this.registry.metrics();
    }
}
