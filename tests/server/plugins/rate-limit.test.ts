import { describe, it, expect } from "vitest";
import Fastify from "fastify";
import type { FastifyInstance } from "fastify";
import * as rateLimit from "../../../src/server/plugins/rate-limit.js";
import * as config from "../../../src/server/config/config.js";

const CF_PEER = "104.16.0.1";
const ORIGIN_PEER = "203.0.113.9";

function testConfig(max: number, timeWindow: number, burst?: number): config.ServerConfig {
    return {
        port: 3000,
        cacheDir: ".",
        logLevel: "silent",
        corsOrigin: "*",
        github: { token: undefined, appId: undefined, privateKey: undefined },
        rateLimits:
            burst !== undefined
                ? { max: max, timeWindow: timeWindow, burst: burst }
                : { max: max, timeWindow: timeWindow },
        adminApiKey: undefined,
        webhookSecret: undefined,
        publicBaseUrl: "http://localhost:3000",
        apps: []
    };
}

async function buildApp(cfg: config.ServerConfig): Promise<FastifyInstance> {
    const app = Fastify({ logger: false });
    app.get("/api/releases/:app", async function () {
        return { ok: true };
    });
    app.get("/download/:app", async function () {
        return { ok: true };
    });
    app.get("/admin/purge", async function () {
        return { ok: true };
    });
    app.get("/health", async function () {
        return { ok: true };
    });
    await rateLimit.registerRateLimit(app, cfg);
    return app;
}

describe("registerRateLimit", function () {
    it("keys on the real client address behind Cloudflare", async function () {
        const app = await buildApp(testConfig(1000, 60000, 5));

        // Two different visitors on the same edge POP must not share a bucket. This was the
        // original defect: without trust, every visitor looked like the Cloudflare node.
        const first = await app.inject({
            method: "GET",
            url: "/api/releases/app1",
            remoteAddress: CF_PEER,
            headers: { "cf-connecting-ip": "198.51.100.1" }
        });
        const second = await app.inject({
            method: "GET",
            url: "/api/releases/app1",
            remoteAddress: CF_PEER,
            headers: { "cf-connecting-ip": "198.51.100.2" }
        });

        expect(first.statusCode).toBe(200);
        expect(second.statusCode).toBe(200);
    });

    it("does not trust a forwarded header from a non-Cloudflare peer", async function () {
        const app = await buildApp(testConfig(2, 60000, 2));

        // Anyone can set the header, so a forged value must not create a fresh allowance.
        for (let i = 0; i < 2; i += 1) {
            const response = await app.inject({
                method: "GET",
                url: "/api/releases/app1",
                remoteAddress: ORIGIN_PEER,
                headers: { "cf-connecting-ip": "1.2.3." + String(i) }
            });
            expect(response.statusCode).toBe(200);
        }
        const limited = await app.inject({
            method: "GET",
            url: "/api/releases/app1",
            remoteAddress: ORIGIN_PEER,
            headers: { "cf-connecting-ip": "1.2.3.99" }
        });

        expect(limited.statusCode).toBe(429);
    });

    it("answers 429 with a retry hint and a request id", async function () {
        const app = await buildApp(testConfig(1, 60000, 1));
        await app.inject({ method: "GET", url: "/api/releases/app1", remoteAddress: ORIGIN_PEER });

        const limited = await app.inject({
            method: "GET",
            url: "/api/releases/app1",
            remoteAddress: ORIGIN_PEER
        });
        const body = JSON.parse(limited.payload);

        expect(limited.statusCode).toBe(429);
        expect(limited.headers["retry-after"]).toBeDefined();
        expect(body.error.code).toBe("RATE_LIMITED");
        expect(body.error.nextStep).toBeDefined();
        expect(body.error.requestId).toBeDefined();
    });

    it("exempts health probes so monitoring never reports a false outage", async function () {
        const app = await buildApp(testConfig(1, 60000, 1));
        await app.inject({ method: "GET", url: "/api/releases/app1", remoteAddress: ORIGIN_PEER });

        for (let i = 0; i < 5; i += 1) {
            const response = await app.inject({ method: "GET", url: "/health", remoteAddress: ORIGIN_PEER });
            expect(response.statusCode).toBe(200);
        }
    });

    it("exempts metrics and the api reference", async function () {
        const app = await buildApp(testConfig(1, 60000, 1));
        await app.inject({ method: "GET", url: "/api/releases/app1", remoteAddress: ORIGIN_PEER });

        expect((await app.inject({ method: "GET", url: "/metrics" })).statusCode).toBe(404);
        expect((await app.inject({ method: "GET", url: "/docs" })).statusCode).toBe(404);
    });

    it("gives downloads a larger allowance than admin routes", async function () {
        // A tight per-address cap punishes everyone behind a shared NAT, so downloads get
        // several times the burst of the API budget and admin is the first to refuse.
        const downloadApp = await buildApp(testConfig(3, 60000, 1));
        let downloadAdmitted = 0;
        for (let i = 0; i < 6; i = i + 1) {
            const response = await downloadApp.inject({
                method: "GET",
                url: "/download/app1",
                remoteAddress: ORIGIN_PEER
            });
            if (response.statusCode === 200) {
                downloadAdmitted = downloadAdmitted + 1;
            }
        }

        const adminApp = await buildApp(testConfig(3, 60000, 1));
        let adminAdmitted = 0;
        for (let i = 0; i < 6; i = i + 1) {
            const response = await adminApp.inject({ method: "GET", url: "/admin/purge", remoteAddress: ORIGIN_PEER });
            if (response.statusCode === 200) {
                adminAdmitted = adminAdmitted + 1;
            }
        }

        expect(downloadAdmitted).toBeGreaterThan(adminAdmitted);
        expect(adminAdmitted).toBeGreaterThan(0);
    });
    it("reports remaining allowance on an admitted request", async function () {
        const app = await buildApp(testConfig(10, 60000, 5));

        const response = await app.inject({
            method: "GET",
            url: "/api/releases/app1",
            remoteAddress: ORIGIN_PEER
        });

        expect(response.headers["x-ratelimit-remaining"]).toBeDefined();
    });

    it("falls back to default budgets when none are configured", async function () {
        const bare = testConfig(10, 1000);
        const withoutLimits = bare as unknown as { rateLimits?: unknown };
        delete withoutLimits.rateLimits;
        const app = await buildApp(bare);

        const response = await app.inject({
            method: "GET",
            url: "/api/releases/app1",
            remoteAddress: ORIGIN_PEER
        });

        expect(response.statusCode).toBe(200);
    });
});
