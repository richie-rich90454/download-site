import { describe, it, expect } from "vitest";
import Fastify from "fastify";
import * as requestLogging from "../../../src/server/plugins/request-logging.js";
import { SilentLogger } from "../test-helpers.js";

describe("registerRequestLogging", function () {
    it("uses x-request-id header when present", async function () {
        const app = Fastify({ logger: false });
        const logger = new SilentLogger();
        await requestLogging.registerRequestLogging(app, logger);
        app.get("/test", async function () {
            return "ok";
        });

        const response = await app.inject({
            method: "GET",
            url: "/test",
            headers: { "x-request-id": "custom-id" }
        });

        expect(response.statusCode).toBe(200);
        expect(response.headers["x-request-id"]).toBe("custom-id");
    });

    it("generates request id when header is missing", async function () {
        const app = Fastify({ logger: false });
        const logger = new SilentLogger();
        await requestLogging.registerRequestLogging(app, logger);
        app.get("/test", async function () {
            return "ok";
        });

        const response = await app.inject({ method: "GET", url: "/test" });

        expect(response.statusCode).toBe(200);
        expect(typeof response.headers["x-request-id"]).toBe("string");
        expect((response.headers["x-request-id"] as string).length).toBeGreaterThan(0);
    });
});
