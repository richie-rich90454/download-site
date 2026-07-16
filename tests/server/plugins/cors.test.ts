import { describe, it, expect } from "vitest";
import Fastify from "fastify";
import * as cors from "../../../src/server/plugins/cors.js";
import type { ServerConfig } from "../../../src/server/config/config.js";

describe("registerCors", function () {
    it("uses configured cors origin", async function () {
        const app = Fastify({ logger: false });
        const config: ServerConfig = {
            port: 3000,
            cacheDir: "./cache",
            logLevel: "silent",
            corsOrigin: "https://example.com",
            github: { token: undefined, appId: undefined, privateKey: undefined },
            rateLimits: { max: 100, timeWindow: 60000 },
            apps: []
        };

        await cors.registerCors(app, config);

        const response = await app.inject({
            method: "OPTIONS",
            url: "/",
            headers: {
                origin: "https://example.com",
                "access-control-request-method": "GET"
            }
        });

        expect(response.statusCode).toBe(204);
        expect(response.headers["access-control-allow-origin"]).toBe("https://example.com");
    });

    it("defaults to wildcard origin when corsOrigin is undefined", async function () {
        const app = Fastify({ logger: false });
        const config: ServerConfig = {
            port: 3000,
            cacheDir: "./cache",
            logLevel: "silent",
            corsOrigin: undefined,
            github: { token: undefined, appId: undefined, privateKey: undefined },
            rateLimits: { max: 100, timeWindow: 60000 },
            apps: []
        };

        await cors.registerCors(app, config);

        const response = await app.inject({
            method: "OPTIONS",
            url: "/",
            headers: {
                origin: "https://any.com",
                "access-control-request-method": "GET"
            }
        });

        expect(response.statusCode).toBe(204);
        expect(response.headers["access-control-allow-origin"]).toBe("*");
    });
});
