import { describe, it, expect, beforeEach, vi } from "vitest";
import * as crypto from "node:crypto";

vi.mock("undici", function () {
    return {
        request: vi.fn()
    };
});

import * as undici from "undici";
import * as metrics from "../../../src/server/telemetry/metrics.js";
import * as githubProvider from "../../../src/server/github/github-provider.js";
import { SilentLogger } from "../test-helpers.js";

function createResponse(
    status: number,
    body: unknown,
    headers?: Record<string, string>
): Awaited<ReturnType<typeof undici.request>> {
    const responseHeaders: Record<string, string> = {};
    const headerKeys = headers !== undefined ? Object.keys(headers) : [];
    for (let i = 0; i < headerKeys.length; i = i + 1) {
        const key = headerKeys[i];
        const value = headers[key];
        if (value !== undefined) {
            responseHeaders[key] = value;
        }
    }
    return {
        statusCode: status,
        headers: responseHeaders,
        body: {
            text: function () {
                return Promise.resolve(JSON.stringify(body));
            }
        }
    } as unknown as Awaited<ReturnType<typeof undici.request>>;
}

function createProvider(token: string | undefined): githubProvider.GitHubProvider {
    const metricsService = new metrics.MetricsService();
    const provider = new githubProvider.GitHubProvider(token, undefined, undefined, new SilentLogger(), metricsService);
    const providerRecord = provider as unknown as Record<string, number>;
    providerRecord.baseDelayMs = 0;
    providerRecord.maxDelayMs = 0;
    return provider;
}

function generateKeyPair(): { privateKey: string; publicKey: string } {
    const result = crypto.generateKeyPairSync("rsa", {
        modulusLength: 2048,
        publicKeyEncoding: { type: "spki", format: "pem" },
        privateKeyEncoding: { type: "pkcs8", format: "pem" }
    });
    return { privateKey: result.privateKey, publicKey: result.publicKey };
}

function createProviderWithJwt(appId: string, privateKey: string): githubProvider.GitHubProvider {
    const metricsService = new metrics.MetricsService();
    const provider = new githubProvider.GitHubProvider(
        undefined,
        appId,
        privateKey,
        new SilentLogger(),
        metricsService
    );
    const providerRecord = provider as unknown as Record<string, number>;
    providerRecord.baseDelayMs = 0;
    providerRecord.maxDelayMs = 0;
    return provider;
}

describe("GitHubProvider", function () {
    beforeEach(function () {
        vi.mocked(undici.request).mockReset();
    });

    it("lists releases successfully", async function () {
        const body = [
            {
                tag_name: "v1.0.0",
                name: "Release 1.0.0",
                body: "Notes",
                published_at: "2024-01-01T00:00:00Z",
                prerelease: false,
                assets: []
            }
        ];
        vi.mocked(undici.request).mockResolvedValueOnce(createResponse(200, body));

        const provider = createProvider(undefined);
        const result = await provider.listReleases("owner/repo");

        expect(result.fromCache).toBe(false);
        expect(result.data.length).toBe(1);
        expect(result.data[0].tag_name).toBe("v1.0.0");
    });

    it("returns cached result for 304 responses", async function () {
        vi.mocked(undici.request).mockResolvedValueOnce(createResponse(304, undefined, { etag: '"abc123"' }));

        const provider = createProvider(undefined);
        const result = await provider.listReleases("owner/repo", { etag: '"abc123"' });

        expect(result.fromCache).toBe(true);
        expect(result.etag).toBe('"abc123"');
    });

    it("retries on network errors", async function () {
        const body = [
            {
                tag_name: "v1.0.0",
                name: "Release 1.0.0",
                body: "Notes",
                published_at: "2024-01-01T00:00:00Z",
                prerelease: false,
                assets: []
            }
        ];
        vi.mocked(undici.request)
            .mockRejectedValueOnce(new Error("network failure"))
            .mockResolvedValueOnce(createResponse(200, body));

        const provider = createProvider(undefined);
        const result = await provider.listReleases("owner/repo");

        expect(result.data.length).toBe(1);
        expect(undici.request).toHaveBeenCalledTimes(2);
    });

    it("throws after exhausting retries", async function () {
        vi.mocked(undici.request).mockRejectedValue(new Error("network failure"));

        const provider = createProvider(undefined);

        await expect(provider.listReleases("owner/repo")).rejects.toThrow("network failure");
    });

    it("opens circuit breaker after consecutive failures", async function () {
        vi.mocked(undici.request).mockRejectedValue(new Error("persistent failure"));

        const provider = createProvider(undefined);

        for (let i = 0; i < 6; i = i + 1) {
            try {
                await provider.listReleases("owner/repo");
            } catch (_err) {
                // expected
            }
        }

        await expect(provider.listReleases("owner/repo")).rejects.toThrow("Circuit breaker is open");
    });

    it("fetches release by tag", async function () {
        const body = {
            tag_name: "v1.0.0",
            name: "Release 1.0.0",
            body: "Notes",
            published_at: "2024-01-01T00:00:00Z",
            prerelease: false,
            assets: []
        };
        vi.mocked(undici.request).mockResolvedValueOnce(createResponse(200, body));

        const provider = createProvider(undefined);
        const result = await provider.getReleaseByTag("owner/repo", "v1.0.0");

        expect(result.data.tag_name).toBe("v1.0.0");
    });

    it("paginates through all releases", async function () {
        const page1 = [
            {
                tag_name: "v1.1.0",
                name: "Release 1.1.0",
                body: "Notes",
                published_at: "2024-02-01T00:00:00Z",
                prerelease: false,
                assets: []
            }
        ];
        const page2 = [
            {
                tag_name: "v1.0.0",
                name: "Release 1.0.0",
                body: "Notes",
                published_at: "2024-01-01T00:00:00Z",
                prerelease: false,
                assets: []
            }
        ];
        vi.mocked(undici.request)
            .mockResolvedValueOnce(
                createResponse(200, page1, {
                    link: '<https://api.github.com/repos/owner/repo/releases?page=2&per_page=30>; rel="next"'
                })
            )
            .mockResolvedValueOnce(createResponse(200, page2));

        const provider = createProvider(undefined);
        const result = await provider.fetchAllReleases("owner/repo");

        expect(result.length).toBe(2);
        expect(result[0].tag_name).toBe("v1.1.0");
        expect(result[1].tag_name).toBe("v1.0.0");
    });

    it("coalesces identical in-flight requests", async function () {
        const body = [
            {
                tag_name: "v1.0.0",
                name: "Release 1.0.0",
                body: "Notes",
                published_at: "2024-01-01T00:00:00Z",
                prerelease: false,
                assets: []
            }
        ];
        vi.mocked(undici.request).mockResolvedValueOnce(createResponse(200, body));

        const provider = createProvider(undefined);
        const promise1 = provider.listReleases("owner/repo");
        const promise2 = provider.listReleases("owner/repo");
        const results = await Promise.all([promise1, promise2]);

        expect(results[0].data[0].tag_name).toBe("v1.0.0");
        expect(results[1].data[0].tag_name).toBe("v1.0.0");
        expect(undici.request).toHaveBeenCalledTimes(1);
    });

    it("uses token authentication when provided", async function () {
        const body = [
            {
                tag_name: "v1.0.0",
                name: "Release 1.0.0",
                body: "Notes",
                published_at: "2024-01-01T00:00:00Z",
                prerelease: false,
                assets: []
            }
        ];
        vi.mocked(undici.request).mockResolvedValueOnce(createResponse(200, body));

        const provider = createProvider("token1");
        await provider.listReleases("owner/repo");

        const calls = vi.mocked(undici.request).mock.calls;
        expect(calls.length).toBe(1);
        const options = calls[0][1] as Record<string, unknown>;
        const headers = options.headers as Record<string, string>;
        expect(headers.Authorization).toBe("token token1");
    });

    it("falls back to next token on 401", async function () {
        const body = [
            {
                tag_name: "v1.0.0",
                name: "Release 1.0.0",
                body: "Notes",
                published_at: "2024-01-01T00:00:00Z",
                prerelease: false,
                assets: []
            }
        ];
        vi.mocked(undici.request)
            .mockResolvedValueOnce(createResponse(401, {}))
            .mockResolvedValueOnce(createResponse(200, body));

        const provider = createProvider("bad,good");
        const result = await provider.listReleases("owner/repo");

        expect(result.data[0].tag_name).toBe("v1.0.0");
    });

    it("extracts etag from array header", async function () {
        const body = [
            {
                tag_name: "v1.0.0",
                name: "Release 1.0.0",
                body: "Notes",
                published_at: "2024-01-01T00:00:00Z",
                prerelease: false,
                assets: []
            }
        ];
        const response = createResponse(200, body);
        response.headers = { etag: ['"array-etag"'] };
        vi.mocked(undici.request).mockResolvedValueOnce(response);

        const provider = createProvider(undefined);
        const result = await provider.listReleases("owner/repo");

        expect(result.etag).toBe('"array-etag"');
    });

    it("retries on 403 with retry-after", async function () {
        const body = [
            {
                tag_name: "v1.0.0",
                name: "Release 1.0.0",
                body: "Notes",
                published_at: "2024-01-01T00:00:00Z",
                prerelease: false,
                assets: []
            }
        ];
        vi.mocked(undici.request)
            .mockResolvedValueOnce(createResponse(403, {}, { "retry-after": "0" }))
            .mockResolvedValueOnce(createResponse(200, body));

        const provider = createProvider(undefined);
        const result = await provider.listReleases("owner/repo");

        expect(result.data[0].tag_name).toBe("v1.0.0");
        expect(undici.request).toHaveBeenCalledTimes(2);
    });

    it("throws on non-retryable error status", async function () {
        vi.mocked(undici.request).mockResolvedValueOnce(createResponse(500, {}));

        const provider = createProvider(undefined);

        await expect(provider.listReleases("owner/repo")).rejects.toThrow("GitHub API error 500");
        expect(undici.request).toHaveBeenCalledTimes(1);
    });

    it("throws on invalid JSON response", async function () {
        const response = createResponse(200, {});
        response.body = {
            text: function () {
                return Promise.resolve("not-json");
            }
        };
        vi.mocked(undici.request).mockResolvedValueOnce(response);

        const provider = createProvider(undefined);

        await expect(provider.listReleases("owner/repo")).rejects.toThrow();
    });

    it("stops pagination when link header has no next relation", async function () {
        const page = [
            {
                tag_name: "v1.0.0",
                name: "Release 1.0.0",
                body: "Notes",
                published_at: "2024-01-01T00:00:00Z",
                prerelease: false,
                assets: []
            }
        ];
        vi.mocked(undici.request).mockResolvedValueOnce(
            createResponse(200, page, {
                link: '<https://api.github.com/repos/owner/repo/releases?page=1&per_page=30>; rel="last"'
            })
        );

        const provider = createProvider(undefined);
        const result = await provider.fetchAllReleases("owner/repo");

        expect(result.length).toBe(1);
        expect(undici.request).toHaveBeenCalledTimes(1);
    });

    it("stops pagination when link header is absent", async function () {
        const page = [
            {
                tag_name: "v1.0.0",
                name: "Release 1.0.0",
                body: "Notes",
                published_at: "2024-01-01T00:00:00Z",
                prerelease: false,
                assets: []
            }
        ];
        vi.mocked(undici.request).mockResolvedValueOnce(createResponse(200, page));

        const provider = createProvider(undefined);
        const result = await provider.fetchAllReleases("owner/repo");

        expect(result.length).toBe(1);
        expect(undici.request).toHaveBeenCalledTimes(1);
    });

    it("authenticates with GitHub App JWT when configured", async function () {
        const body = [
            {
                tag_name: "v1.0.0",
                name: "Release 1.0.0",
                body: "Notes",
                published_at: "2024-01-01T00:00:00Z",
                prerelease: false,
                assets: []
            }
        ];
        vi.mocked(undici.request).mockResolvedValueOnce(createResponse(200, body));
        const keys = generateKeyPair();
        const provider = createProviderWithJwt("123", keys.privateKey);

        await provider.listReleases("owner/repo");

        const calls = vi.mocked(undici.request).mock.calls;
        expect(calls.length).toBe(1);
        const options = calls[0][1] as Record<string, unknown>;
        const headers = options.headers as Record<string, string>;
        expect(headers.Authorization.indexOf("Bearer ")).toBe(0);
    });

    it("reuses cached GitHub App JWT", async function () {
        const body = [
            {
                tag_name: "v1.0.0",
                name: "Release 1.0.0",
                body: "Notes",
                published_at: "2024-01-01T00:00:00Z",
                prerelease: false,
                assets: []
            }
        ];
        vi.mocked(undici.request).mockResolvedValue(createResponse(200, body));
        const keys = generateKeyPair();
        const provider = createProviderWithJwt("123", keys.privateKey);

        await provider.listReleases("owner/repo");
        await provider.listReleases("owner/repo");

        const calls = vi.mocked(undici.request).mock.calls;
        expect(calls.length).toBe(2);
        const firstOptions = calls[0][1] as Record<string, unknown>;
        const secondOptions = calls[1][1] as Record<string, unknown>;
        expect((firstOptions.headers as Record<string, string>).Authorization).toBe(
            (secondOptions.headers as Record<string, string>).Authorization
        );
    });

    it("throws after exhausting all tokens with 401", async function () {
        vi.mocked(undici.request).mockResolvedValue(createResponse(401, {}));

        const provider = createProvider("bad,worse");

        await expect(provider.listReleases("owner/repo")).rejects.toThrow("GitHub API error 401");
        expect(undici.request).toHaveBeenCalledTimes(2);
    });

    it("stops pagination on 304 response", async function () {
        vi.mocked(undici.request).mockResolvedValueOnce(createResponse(304, undefined, { etag: '"abc123"' }));

        const provider = createProvider(undefined);
        const result = await provider.fetchAllReleases("owner/repo");

        expect(result.length).toBe(0);
        expect(undici.request).toHaveBeenCalledTimes(1);
    });

    it("retries fetchAllReleases on 403 with retry-after", async function () {
        const body = [
            {
                tag_name: "v1.0.0",
                name: "Release 1.0.0",
                body: "Notes",
                published_at: "2024-01-01T00:00:00Z",
                prerelease: false,
                assets: []
            }
        ];
        vi.mocked(undici.request)
            .mockResolvedValueOnce(createResponse(403, {}, { "retry-after": "0" }))
            .mockResolvedValueOnce(createResponse(200, body));

        const provider = createProvider(undefined);
        const result = await provider.fetchAllReleases("owner/repo");

        expect(result.length).toBe(1);
        expect(undici.request).toHaveBeenCalledTimes(2);
    });

    it("retries fetchAllReleases on network errors", async function () {
        const body = [
            {
                tag_name: "v1.0.0",
                name: "Release 1.0.0",
                body: "Notes",
                published_at: "2024-01-01T00:00:00Z",
                prerelease: false,
                assets: []
            }
        ];
        vi.mocked(undici.request)
            .mockRejectedValueOnce(new Error("network failure"))
            .mockResolvedValueOnce(createResponse(200, body));

        const provider = createProvider(undefined);
        const result = await provider.fetchAllReleases("owner/repo");

        expect(result.length).toBe(1);
        expect(undici.request).toHaveBeenCalledTimes(2);
    });

    it("throws on non-retryable error status in fetchAllReleases", async function () {
        vi.mocked(undici.request).mockResolvedValueOnce(createResponse(500, {}));

        const provider = createProvider(undefined);

        await expect(provider.fetchAllReleases("owner/repo")).rejects.toThrow("GitHub API error 500");
    });

    it("transitions circuit breaker to half-open after reset timeout", async function () {
        vi.mocked(undici.request).mockRejectedValue(new Error("persistent failure"));

        const provider = createProvider(undefined);
        const breaker = (provider as unknown as Record<string, githubTypes.CircuitBreakerState>).circuitBreaker;
        breaker.lastFailureTime = Date.now() - 35000;
        breaker.state = "open";

        await expect(provider.listReleases("owner/repo")).rejects.toThrow();
        expect(breaker.state).toBe("half-open");
    });

    it("creates JWT from private key with escaped newlines", async function () {
        const body = [
            {
                tag_name: "v1.0.0",
                name: "Release 1.0.0",
                body: "Notes",
                published_at: "2024-01-01T00:00:00Z",
                prerelease: false,
                assets: []
            }
        ];
        vi.mocked(undici.request).mockResolvedValueOnce(createResponse(200, body));
        const keys = generateKeyPair();
        const escapedKey = keys.privateKey.replace(/\n/g, "\\n");
        const provider = createProviderWithJwt("123", escapedKey);

        await provider.listReleases("owner/repo");

        const calls = vi.mocked(undici.request).mock.calls;
        expect(calls.length).toBe(1);
        const options = calls[0][1] as Record<string, unknown>;
        const headers = options.headers as Record<string, string>;
        expect(headers.Authorization.indexOf("Bearer ")).toBe(0);
    });

    it("falls back to unauthenticated request when no tokens are configured", async function () {
        const body = [
            {
                tag_name: "v1.0.0",
                name: "Release 1.0.0",
                body: "Notes",
                published_at: "2024-01-01T00:00:00Z",
                prerelease: false,
                assets: []
            }
        ];
        vi.mocked(undici.request).mockResolvedValueOnce(createResponse(200, body));

        const provider = createProvider(undefined);
        await provider.listReleases("owner/repo");

        const calls = vi.mocked(undici.request).mock.calls;
        expect(calls.length).toBe(1);
        const options = calls[0][1] as Record<string, unknown>;
        const headers = options.headers as Record<string, string>;
        expect(headers.Authorization).toBeUndefined();
    });

    it("does not reuse expired in-flight coalescing entries", async function () {
        const body = [
            {
                tag_name: "v1.0.0",
                name: "Release 1.0.0",
                body: "Notes",
                published_at: "2024-01-01T00:00:00Z",
                prerelease: false,
                assets: []
            }
        ];
        vi.mocked(undici.request).mockResolvedValue(createResponse(200, body));

        const provider = createProvider(undefined);
        const inFlight = (provider as unknown as Record<string, Map<string, unknown>>).inFlight;
        const key = "https://api.github.com/repos/owner/repo/releases?page=1&per_page=30|";
        const promise = Promise.resolve({ data: [], etag: undefined, fromCache: true });
        inFlight.set(key, { promise: promise, expiry: Date.now() - 1000 });

        const result = await provider.listReleases("owner/repo");

        expect(result.data[0].tag_name).toBe("v1.0.0");
        expect(undici.request).toHaveBeenCalledTimes(1);
    });

    it("extracts string etag from response headers", async function () {
        const body = [
            {
                tag_name: "v1.0.0",
                name: "Release 1.0.0",
                body: "Notes",
                published_at: "2024-01-01T00:00:00Z",
                prerelease: false,
                assets: []
            }
        ];
        vi.mocked(undici.request).mockResolvedValueOnce(createResponse(200, body, { etag: '"string-etag"' }));

        const provider = createProvider(undefined);
        const result = await provider.listReleases("owner/repo");

        expect(result.etag).toBe('"string-etag"');
    });

    it("retries on 403 when retry-after header is not a string", async function () {
        const body = [
            {
                tag_name: "v1.0.0",
                name: "Release 1.0.0",
                body: "Notes",
                published_at: "2024-01-01T00:00:00Z",
                prerelease: false,
                assets: []
            }
        ];
        const firstResponse = createResponse(403, {}, { "retry-after": "0" });
        firstResponse.headers = { "retry-after": ["0"] };
        vi.mocked(undici.request).mockResolvedValueOnce(firstResponse).mockResolvedValueOnce(createResponse(200, body));

        const provider = createProvider(undefined);
        const result = await provider.listReleases("owner/repo");

        expect(result.data[0].tag_name).toBe("v1.0.0");
        expect(undici.request).toHaveBeenCalledTimes(2);
    });

    it("coalesces identical in-flight raw requests", async function () {
        const body = [
            {
                tag_name: "v1.0.0",
                name: "Release 1.0.0",
                body: "Notes",
                published_at: "2024-01-01T00:00:00Z",
                prerelease: false,
                assets: []
            }
        ];
        vi.mocked(undici.request).mockResolvedValueOnce(createResponse(200, body));

        const provider = createProvider(undefined);
        const promise1 = provider.fetchAllReleases("owner/repo");
        const promise2 = provider.fetchAllReleases("owner/repo");
        const results = await Promise.all([promise1, promise2]);

        expect(results[0].length).toBe(1);
        expect(results[1].length).toBe(1);
        expect(undici.request).toHaveBeenCalledTimes(1);
    });

    it("retries fetchAllReleases on 403 when retry-after header is not a string", async function () {
        const body = [
            {
                tag_name: "v1.0.0",
                name: "Release 1.0.0",
                body: "Notes",
                published_at: "2024-01-01T00:00:00Z",
                prerelease: false,
                assets: []
            }
        ];
        const firstResponse = createResponse(403, {}, { "retry-after": "0" });
        firstResponse.headers = { "retry-after": ["0"] };
        vi.mocked(undici.request).mockResolvedValueOnce(firstResponse).mockResolvedValueOnce(createResponse(200, body));

        const provider = createProvider(undefined);
        const result = await provider.fetchAllReleases("owner/repo");

        expect(result.length).toBe(1);
        expect(undici.request).toHaveBeenCalledTimes(2);
    });

    it("aborts request when timeout fires", async function () {
        vi.mocked(undici.request).mockImplementation(function (_url, options) {
            const signal = (options as Record<string, unknown>).signal as AbortSignal;
            return new Promise(function (_resolve, reject) {
                function onAbort() {
                    const error = new Error("AbortError");
                    error.name = "AbortError";
                    reject(error);
                }
                signal.addEventListener("abort", onAbort);
            });
        });

        const provider = createProvider(undefined);
        const providerRecord = provider as unknown as Record<string, number>;
        providerRecord.requestTimeoutMs = 0;

        await expect(provider.listReleases("owner/repo")).rejects.toThrow("AbortError");
    });

    it("handles non-error rejection in fetchWithRetry", async function () {
        vi.mocked(undici.request).mockRejectedValue("string error");

        const provider = createProvider(undefined);

        await expect(provider.listReleases("owner/repo")).rejects.toThrow("string error");
    });

    it("throws after exhausting retries in fetchRawWithRetry", async function () {
        vi.mocked(undici.request).mockRejectedValue(new Error("network failure"));

        const provider = createProvider(undefined);
        const providerRecord = provider as unknown as Record<string, number>;
        providerRecord.circuitBreakerThreshold = 100;

        await expect(provider.fetchAllReleases("owner/repo")).rejects.toThrow("network failure");
    });

    it("handles non-error rejection in fetchRawWithRetry", async function () {
        vi.mocked(undici.request).mockRejectedValue("string error");

        const provider = createProvider(undefined);
        const providerRecord = provider as unknown as Record<string, number>;
        providerRecord.circuitBreakerThreshold = 100;

        await expect(provider.fetchAllReleases("owner/repo")).rejects.toThrow("string error");
    });

    it("passes page and perPage options to listReleases", async function () {
        const body = [
            {
                tag_name: "v1.0.0",
                name: "Release 1.0.0",
                body: "Notes",
                published_at: "2024-01-01T00:00:00Z",
                prerelease: false,
                assets: []
            }
        ];
        vi.mocked(undici.request).mockResolvedValueOnce(createResponse(200, body));

        const provider = createProvider(undefined);
        const result = await provider.listReleases("owner/repo", { page: 2, perPage: 10 });

        expect(result.data.length).toBe(1);
        const calls = vi.mocked(undici.request).mock.calls;
        const url = calls[0][0] as string;
        expect(url.indexOf("page=2") >= 0).toBe(true);
        expect(url.indexOf("per_page=10") >= 0).toBe(true);
    });

    it("passes perPage option to fetchAllReleases", async function () {
        const body = [
            {
                tag_name: "v1.0.0",
                name: "Release 1.0.0",
                body: "Notes",
                published_at: "2024-01-01T00:00:00Z",
                prerelease: false,
                assets: []
            }
        ];
        vi.mocked(undici.request).mockResolvedValueOnce(createResponse(200, body));

        const provider = createProvider(undefined);
        const result = await provider.fetchAllReleases("owner/repo", 50);

        expect(result.length).toBe(1);
        const calls = vi.mocked(undici.request).mock.calls;
        const url = calls[0][0] as string;
        expect(url.indexOf("per_page=50") >= 0).toBe(true);
    });

    it("skips empty tokens when parsing comma separated tokens", async function () {
        const body = [
            {
                tag_name: "v1.0.0",
                name: "Release 1.0.0",
                body: "Notes",
                published_at: "2024-01-01T00:00:00Z",
                prerelease: false,
                assets: []
            }
        ];
        vi.mocked(undici.request)
            .mockResolvedValueOnce(createResponse(401, {}))
            .mockResolvedValueOnce(createResponse(200, body));

        const provider = createProvider("bad,,good");
        const result = await provider.listReleases("owner/repo");

        expect(result.data[0].tag_name).toBe("v1.0.0");
    });

    it("throws on 300 status in listReleases", async function () {
        vi.mocked(undici.request).mockResolvedValueOnce(createResponse(300, {}));

        const provider = createProvider(undefined);

        await expect(provider.listReleases("owner/repo")).rejects.toThrow("GitHub API error 300");
    });

    it("uses fallback error when lastError is undefined in fetchWithRetry", async function () {
        const provider = createProvider(undefined);
        const providerRecord = provider as unknown as Record<string, number>;
        providerRecord.maxRetries = -1;

        await expect(provider.listReleases("owner/repo")).rejects.toThrow("GitHub request failed:");
    });

    it("uses fallback error when lastError is undefined in fetchRawWithRetry", async function () {
        const provider = createProvider(undefined);
        const providerRecord = provider as unknown as Record<string, number>;
        providerRecord.maxRetries = -1;

        await expect(provider.fetchAllReleases("owner/repo")).rejects.toThrow("GitHub request failed:");
    });

    it("includes etag in raw coalesce key", async function () {
        const body = [
            {
                tag_name: "v1.0.0",
                name: "Release 1.0.0",
                body: "Notes",
                published_at: "2024-01-01T00:00:00Z",
                prerelease: false,
                assets: []
            }
        ];
        vi.mocked(undici.request).mockResolvedValueOnce(createResponse(200, body));

        const provider = createProvider(undefined);
        const providerRecord = provider as unknown as Record<
            string,
            (url: string, etag: string | undefined) => Promise<Awaited<ReturnType<typeof undici.request>>>
        >;
        const result = await providerRecord.fetchRawWithRetry(
            "https://api.github.com/repos/owner/repo/releases?page=1&per_page=30",
            '"etag"'
        );

        expect(result.statusCode).toBe(200);
    });
});
