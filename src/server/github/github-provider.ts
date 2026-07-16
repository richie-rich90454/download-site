import * as crypto from "node:crypto";
import * as undici from "undici";
import * as z from "zod";
import * as types from "../../shared/types.js";
import * as schemas from "../../shared/schemas.js";
import * as logger from "../logging/logger.js";
import * as metrics from "../telemetry/metrics.js";
import * as githubTypes from "./github-types.js";

type UndiciResponse = Awaited<ReturnType<typeof undici.request>>;

export class GitHubProvider implements githubTypes.GitHubProvider {
    private readonly baseUrl: string;
    private readonly tokens: string[];
    private readonly appId: string | undefined;
    private readonly privateKey: string | undefined;
    private readonly maxRetries: number;
    private readonly baseDelayMs: number;
    private readonly maxDelayMs: number;
    private readonly circuitBreakerThreshold: number;
    private readonly circuitBreakerResetMs: number;
    private readonly requestTimeoutMs: number;
    private readonly coalesceWindowMs: number;
    private readonly logger: logger.Logger;
    private readonly metrics: metrics.MetricsService;
    private readonly inFlight: Map<string, githubTypes.InFlightRequest<unknown>>;
    private readonly circuitBreaker: githubTypes.CircuitBreakerState;
    private appJwt: string | undefined;
    private appJwtExpiry: number;

    constructor(
        token: string | undefined,
        appId: string | undefined,
        privateKey: string | undefined,
        loggerInstance: logger.Logger,
        metricsInstance: metrics.MetricsService
    ) {
        this.baseUrl = "https://api.github.com";
        this.tokens = this.parseTokens(token);
        this.appId = appId;
        this.privateKey = privateKey;
        this.maxRetries = 5;
        this.baseDelayMs = 1000;
        this.maxDelayMs = 32000;
        this.circuitBreakerThreshold = 5;
        this.circuitBreakerResetMs = 30000;
        this.requestTimeoutMs = 30000;
        this.coalesceWindowMs = 5000;
        this.logger = loggerInstance;
        this.metrics = metricsInstance;
        this.inFlight = new Map<string, githubTypes.InFlightRequest<unknown>>();
        this.circuitBreaker = {
            failures: 0,
            lastFailureTime: 0,
            state: "closed"
        };
        this.appJwt = undefined;
        this.appJwtExpiry = 0;
    }

    async listReleases(
        repo: string,
        options?: githubTypes.ListReleasesOptions
    ): Promise<githubTypes.FetchResult<types.GitHubRelease[]>> {
        const page = options && options.page !== undefined ? options.page : 1;
        const perPage = options && options.perPage !== undefined ? options.perPage : 30;
        const etag = options && options.etag !== undefined ? options.etag : undefined;
        const url = this.baseUrl + "/repos/" + repo + "/releases?page=" + page + "&per_page=" + perPage;
        return this.fetchWithRetry<types.GitHubRelease[]>(url, schemas.GitHubReleaseSchema.array(), etag);
    }

    async getReleaseByTag(repo: string, tag: string): Promise<githubTypes.FetchResult<types.GitHubRelease>> {
        const url = this.baseUrl + "/repos/" + repo + "/releases/tags/" + tag;
        return this.fetchWithRetry<types.GitHubRelease>(url, schemas.GitHubReleaseSchema, undefined);
    }

    async fetchAllReleases(repo: string, perPage?: number): Promise<types.GitHubRelease[]> {
        const pageSize = perPage !== undefined ? perPage : 30;
        const results: types.GitHubRelease[] = [];
        let page = 1;
        let hasMore = true;
        while (hasMore) {
            const url = this.baseUrl + "/repos/" + repo + "/releases?page=" + page + "&per_page=" + pageSize;
            const response = await this.fetchRawWithRetry(url, undefined);
            if (response.statusCode === 304) {
                break;
            }
            const parsed = await this.parseJson(response);
            const validated = schemas.GitHubReleaseSchema.array().parse(parsed);
            for (let i = 0; i < validated.length; i = i + 1) {
                results.push(validated[i]);
            }
            const linkHeader = response.headers["link"];
            if (typeof linkHeader !== "string") {
                hasMore = false;
            } else {
                hasMore = this.hasNextPage(linkHeader);
                page = page + 1;
            }
        }
        return results;
    }

    private parseTokens(token: string | undefined): string[] {
        if (token === undefined || token.length === 0) {
            return [];
        }
        const parts = token.split(",");
        const result: string[] = [];
        for (let i = 0; i < parts.length; i = i + 1) {
            const trimmed = parts[i].trim();
            if (trimmed.length > 0) {
                result.push(trimmed);
            }
        }
        return result;
    }

    private async fetchWithRetry<T>(
        url: string,
        schema: z.ZodSchema<T>,
        etag: string | undefined
    ): Promise<githubTypes.FetchResult<T>> {
        const coalesceKey = url + "|" + (etag !== undefined ? etag : "");
        const existing = this.inFlight.get(coalesceKey);
        if (existing !== undefined && existing.expiry > Date.now()) {
            return existing.promise as Promise<githubTypes.FetchResult<T>>;
        }
        const promise = this.executeFetchWithRetry<T>(url, schema, etag, coalesceKey);
        this.inFlight.set(coalesceKey, { promise: promise, expiry: Date.now() + this.coalesceWindowMs });
        return promise;
    }

    private async executeFetchWithRetry<T>(
        url: string,
        schema: z.ZodSchema<T>,
        etag: string | undefined,
        coalesceKey: string
    ): Promise<githubTypes.FetchResult<T>> {
        let lastError: Error | undefined;
        await this.checkCircuitBreaker();
        for (let attempt = 0; attempt <= this.maxRetries; attempt = attempt + 1) {
            try {
                const response = await this.tryAllAuthHeaders(url, etag);
                this.metrics.recordGitHubApiCall("GET", response.statusCode);
                if (response.statusCode === 304) {
                    this.recordSuccess();
                    this.inFlight.delete(coalesceKey);
                    return { data: undefined as unknown as T, etag: etag, fromCache: true };
                }
                if (response.statusCode >= 200 && response.statusCode < 300) {
                    const parsed = await this.parseJson(response);
                    const validated = schema.parse(parsed);
                    const rawEtag = response.headers["etag"];
                    let newEtag: string | undefined;
                    if (typeof rawEtag === "string") {
                        newEtag = rawEtag;
                    } else if (Array.isArray(rawEtag) && rawEtag.length > 0) {
                        newEtag = rawEtag[0];
                    } else {
                        newEtag = undefined;
                    }
                    this.recordSuccess();
                    this.inFlight.delete(coalesceKey);
                    return { data: validated, etag: newEtag, fromCache: false };
                }
                if (response.statusCode === 403 || response.statusCode === 429) {
                    const retryAfter = response.headers["retry-after"];
                    let delay: number;
                    if (typeof retryAfter === "string") {
                        delay = Number(retryAfter) * 1000;
                    } else {
                        delay = this.calculateDelay(attempt);
                    }
                    await this.sleep(delay);
                    lastError = new Error("GitHub rate limit status " + response.statusCode);
                    continue;
                }
                lastError = new Error("GitHub API error " + response.statusCode);
                break;
            } catch (err) {
                const message = err instanceof Error ? err.message : String(err);
                lastError = new Error(message);
                if (attempt < this.maxRetries) {
                    const delay = this.calculateDelay(attempt);
                    await this.sleep(delay);
                }
            }
        }
        this.recordFailure(lastError || new Error("GitHub request failed: " + url));
        this.inFlight.delete(coalesceKey);
        throw lastError || new Error("GitHub request failed: " + url);
    }

    private async fetchRawWithRetry(url: string, etag: string | undefined): Promise<UndiciResponse> {
        const coalesceKey = url + "|" + (etag !== undefined ? etag : "") + "|raw";
        const existing = this.inFlight.get(coalesceKey);
        if (existing !== undefined && existing.expiry > Date.now()) {
            return existing.promise as Promise<UndiciResponse>;
        }
        const promise = this.executeFetchRawWithRetry(url, etag, coalesceKey);
        this.inFlight.set(coalesceKey, { promise: promise, expiry: Date.now() + this.coalesceWindowMs });
        return promise;
    }

    private async executeFetchRawWithRetry(
        url: string,
        etag: string | undefined,
        coalesceKey: string
    ): Promise<UndiciResponse> {
        let lastError: Error | undefined;
        for (let attempt = 0; attempt <= this.maxRetries; attempt = attempt + 1) {
            try {
                await this.checkCircuitBreaker();
                const response = await this.tryAllAuthHeaders(url, etag);
                this.metrics.recordGitHubApiCall("GET", response.statusCode);
                if ((response.statusCode >= 200 && response.statusCode < 300) || response.statusCode === 304) {
                    this.recordSuccess();
                    this.inFlight.delete(coalesceKey);
                    return response;
                }
                if (response.statusCode === 403 || response.statusCode === 429) {
                    const retryAfter = response.headers["retry-after"];
                    let delay: number;
                    if (typeof retryAfter === "string") {
                        delay = Number(retryAfter) * 1000;
                    } else {
                        delay = this.calculateDelay(attempt);
                    }
                    await this.sleep(delay);
                    lastError = new Error("GitHub rate limit status " + response.statusCode);
                    this.recordFailure(lastError);
                    continue;
                }
                lastError = new Error("GitHub API error " + response.statusCode);
                this.recordFailure(lastError);
                break;
            } catch (err) {
                const message = err instanceof Error ? err.message : String(err);
                lastError = new Error(message);
                this.recordFailure(lastError);
                if (attempt < this.maxRetries) {
                    const delay = this.calculateDelay(attempt);
                    await this.sleep(delay);
                }
            }
        }
        this.inFlight.delete(coalesceKey);
        throw lastError || new Error("GitHub request failed: " + url);
    }

    private async tryAllAuthHeaders(url: string, etag: string | undefined): Promise<UndiciResponse> {
        const authHeaders = await this.buildAuthHeaders();
        let lastResponse: UndiciResponse | undefined;
        for (let i = 0; i < authHeaders.length; i = i + 1) {
            const response = await this.fetchWithTimeout(url, etag, authHeaders[i]);
            if (response.statusCode !== 401) {
                return response;
            }
            lastResponse = response;
        }
        if (lastResponse !== undefined) {
            return lastResponse;
        }
        return this.fetchWithTimeout(url, etag, "");
    }

    private async buildAuthHeaders(): Promise<string[]> {
        const headers: string[] = [];
        for (let i = 0; i < this.tokens.length; i = i + 1) {
            headers.push("token " + this.tokens[i]);
        }
        if (
            this.appId !== undefined &&
            this.privateKey !== undefined &&
            this.appId.length > 0 &&
            this.privateKey.length > 0
        ) {
            const jwt = await this.getAppJwt();
            headers.push("Bearer " + jwt);
        }
        return headers;
    }

    private async getAppJwt(): Promise<string> {
        const now = Date.now();
        if (this.appJwt !== undefined && this.appJwtExpiry > now + 60000) {
            return this.appJwt;
        }
        this.appJwt = await this.createAppJwt(this.appId as string, this.privateKey as string);
        this.appJwtExpiry = now + 540000;
        return this.appJwt;
    }

    private async fetchWithTimeout(url: string, etag: string | undefined, authHeader: string): Promise<UndiciResponse> {
        const controller = new AbortController();
        const timeout = setTimeout(function () {
            controller.abort();
        }, this.requestTimeoutMs);
        const start = Date.now();
        try {
            const headers: Record<string, string> = {
                Accept: "application/vnd.github+json",
                "X-GitHub-Api-Version": "2022-11-28",
                "User-Agent": "download-server"
            };
            if (authHeader.length > 0) {
                headers.Authorization = authHeader;
            }
            if (etag !== undefined && etag.length > 0) {
                headers["If-None-Match"] = etag;
            }
            const response = await undici.request(url, {
                method: "GET",
                headers: headers,
                signal: controller.signal
            });
            const duration = (Date.now() - start) / 1000;
            this.metrics.recordGitHubApiDuration("GET", duration);
            return response;
        } finally {
            clearTimeout(timeout);
        }
    }

    private async createAppJwt(appId: string, privateKey: string): Promise<string> {
        const now = Math.floor(Date.now() / 1000);
        const header = { alg: "RS256", typ: "JWT" };
        const payload = {
            iat: now - 60,
            exp: now + 600,
            iss: appId,
            aud: "https://api.github.com"
        };
        const encodedHeader = this.base64UrlEncode(JSON.stringify(header));
        const encodedPayload = this.base64UrlEncode(JSON.stringify(payload));
        const signingInput = encodedHeader + "." + encodedPayload;
        const key = this.normalizePrivateKey(privateKey);
        const signature = crypto.createSign("RSA-SHA256").update(signingInput).sign(key, "base64");
        const encodedSignature = this.base64UrlEscape(signature);
        return signingInput + "." + encodedSignature;
    }

    private normalizePrivateKey(key: string): string {
        if (key.indexOf("\\n") >= 0) {
            return key.replace(/\\n/g, "\n");
        }
        return key;
    }

    private base64UrlEncode(input: string): string {
        return Buffer.from(input).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=/g, "");
    }

    private base64UrlEscape(input: string): string {
        return input.replace(/\+/g, "-").replace(/\//g, "_").replace(/=/g, "");
    }

    private async parseJson(response: UndiciResponse): Promise<unknown> {
        const text = await response.body.text();
        try {
            return JSON.parse(text);
        } catch (err) {
            this.logger.error("Failed to parse GitHub JSON response", { body: text });
            throw err;
        }
    }

    private hasNextPage(linkHeader: string): boolean {
        const parts = linkHeader.split(",");
        for (let i = 0; i < parts.length; i = i + 1) {
            const part = parts[i].trim();
            const relMatch = /rel="next"/.exec(part);
            if (relMatch !== null) {
                return true;
            }
        }
        return false;
    }

    private calculateDelay(attempt: number): number {
        const exponential = this.baseDelayMs * Math.pow(2, attempt);
        const capped = Math.min(exponential, this.maxDelayMs);
        const jitter = Math.random() * capped;
        return Math.floor(jitter);
    }

    private async checkCircuitBreaker(): Promise<void> {
        if (this.circuitBreaker.state === "open") {
            const elapsed = Date.now() - this.circuitBreaker.lastFailureTime;
            if (elapsed >= this.circuitBreakerResetMs) {
                this.circuitBreaker.state = "half-open";
                this.circuitBreaker.failures = 0;
            } else {
                throw new Error("Circuit breaker is open");
            }
        }
    }

    private recordSuccess(): void {
        this.circuitBreaker.failures = 0;
        this.circuitBreaker.state = "closed";
    }

    private recordFailure(err: Error): void {
        this.circuitBreaker.failures = this.circuitBreaker.failures + 1;
        this.circuitBreaker.lastFailureTime = Date.now();
        if (this.circuitBreaker.failures >= this.circuitBreakerThreshold) {
            this.circuitBreaker.state = "open";
        }
        this.logger.warn("GitHub provider failure", { error: err.message, failures: this.circuitBreaker.failures });
    }

    private sleep(ms: number): Promise<void> {
        return new Promise(function (resolve) {
            setTimeout(resolve, ms);
        });
    }
}
