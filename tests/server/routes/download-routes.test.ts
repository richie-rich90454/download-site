import * as vitest from "vitest";
import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import * as downloadRoutes from "../../../src/server/routes/download-routes.js";
import type { Services } from "../../../src/server/container.js";
import { SilentLogger } from "../test-helpers.js";

interface RouteRegistration {
    method: string;
    path: string;
    options: unknown;
    handler: unknown;
}

function createFakeApp(services: Partial<Services>): { app: FastifyInstance; routes: RouteRegistration[] } {
    const routes: RouteRegistration[] = [];
    const app = {
        services: services as Services,
        get: function (path: string, options: unknown, handler: unknown): void {
            routes.push({ method: "get", path: path, options: options, handler: handler });
        }
    } as unknown as FastifyInstance;
    return { app: app, routes: routes };
}

function createRequest(
    params: Record<string, unknown>,
    query: Record<string, unknown>,
    headers: Record<string, unknown>
): FastifyRequest {
    return {
        params: params,
        query: query,
        headers: headers,
        body: undefined
    } as unknown as FastifyRequest;
}

function createReply(): {
    reply: { status: (code: number) => unknown; send: (data: unknown) => unknown };
    statusCode: { value: number };
    payload: { value: unknown };
} {
    const statusCode = { value: 0 };
    const payload = { value: undefined as unknown };
    const reply = {
        status: function (code: number) {
            statusCode.value = code;
            return reply;
        },
        send: function (data: unknown) {
            payload.value = data;
            return reply;
        }
    };
    return { reply: reply, statusCode: statusCode, payload: payload };
}

vitest.describe("registerDownloadRoutes", function () {
    function buildServices() {
        const downloadService = {
            resolveAsset: vitest.vi.fn(),
            serveFile: vitest.vi.fn(),
            proxyDownload: vitest.vi.fn()
        };
        const services = {
            download: downloadService,
            logger: new SilentLogger()
        } as unknown as Services;
        return { services: services, downloadService: downloadService };
    }

    vitest.it("uses the first value when user-agent and range headers are arrays", async function () {
        const servicesResult = buildServices();
        const services = servicesResult.services;
        const downloadService = servicesResult.downloadService;
        const context = createFakeApp(services);
        await downloadRoutes.registerDownloadRoutes(context.app);
        const handler = context.routes[0].handler as (request: FastifyRequest, reply: FastifyReply) => Promise<void>;
        const result = {
            filePath: "/tmp/app.exe",
            asset: { name: "app.exe", checksum: "abc123" },
            release: { tag: "v1.0.0" },
            proxied: false
        };
        downloadService.resolveAsset.mockResolvedValue(result);

        const request = createRequest(
            { app: "app1" },
            { version: "v1.0.0", asset: "app.exe", platform: "windows" },
            { "user-agent": ["agent-one", "agent-two"], range: ["bytes=0-1", "bytes=2-3"] }
        );
        const replyResult = createReply();

        await handler(request, replyResult.reply as unknown as FastifyReply);

        vitest.expect(downloadService.resolveAsset).toHaveBeenCalledWith("app1", {
            version: "v1.0.0",
            assetName: "app.exe",
            userAgent: "agent-one",
            platformHint: "windows"
        });
        vitest
            .expect(downloadService.serveFile)
            .toHaveBeenCalledWith("/tmp/app.exe", "app.exe", replyResult.reply, "bytes=0-1", "abc123");
    });

    vitest.it("proxies large assets instead of serving from cache", async function () {
        const servicesResult = buildServices();
        const services = servicesResult.services;
        const downloadService = servicesResult.downloadService;
        const context = createFakeApp(services);
        await downloadRoutes.registerDownloadRoutes(context.app);
        const handler = context.routes[0].handler as (request: FastifyRequest, reply: FastifyReply) => Promise<void>;
        const result = {
            asset: { name: "app.exe" },
            release: { tag: "v1.0.0" },
            proxied: true
        };
        downloadService.resolveAsset.mockResolvedValue(result);

        const request = createRequest(
            { app: "app1" },
            { version: "v1.0.0", asset: "app.exe" },
            { range: "bytes=0-99" }
        );
        const replyResult = createReply();

        await handler(request, replyResult.reply as unknown as FastifyReply);

        vitest
            .expect(downloadService.proxyDownload)
            .toHaveBeenCalledWith("app1", result.asset, result.release, replyResult.reply, "bytes=0-99");
        vitest.expect(downloadService.serveFile).not.toHaveBeenCalled();
    });

    vitest.it("returns 404 when resolveAsset throws a non-Error value", async function () {
        const servicesResult = buildServices();
        const services = servicesResult.services;
        const downloadService = servicesResult.downloadService;
        const context = createFakeApp(services);
        await downloadRoutes.registerDownloadRoutes(context.app);
        const handler = context.routes[0].handler as (request: FastifyRequest, reply: FastifyReply) => Promise<void>;
        downloadService.resolveAsset.mockRejectedValue("asset missing");

        const request = createRequest(
            { app: "app1" },
            { version: "v1.0.0", asset: "app.exe", platform: "windows" },
            { "user-agent": "single-agent", range: "bytes=0-1" }
        );
        const replyResult = createReply();

        await handler(request, replyResult.reply as unknown as FastifyReply);

        vitest.expect(replyResult.statusCode.value).toBe(404);
        vitest.expect(replyResult.payload.value).toEqual({ error: { code: "NOT_FOUND", message: "asset missing" } });
    });

    vitest.it("returns 404 when resolved asset has no file path and is not proxied", async function () {
        const servicesResult = buildServices();
        const services = servicesResult.services;
        const downloadService = servicesResult.downloadService;
        const context = createFakeApp(services);
        await downloadRoutes.registerDownloadRoutes(context.app);
        const handler = context.routes[0].handler as (request: FastifyRequest, reply: FastifyReply) => Promise<void>;
        downloadService.resolveAsset.mockResolvedValue({
            asset: { name: "app.exe" },
            release: { tag: "v1.0.0" },
            proxied: false
        });

        const request = createRequest({ app: "app1" }, {}, {});
        const replyResult = createReply();

        await handler(request, replyResult.reply as unknown as FastifyReply);

        vitest.expect(replyResult.statusCode.value).toBe(404);
        vitest.expect(replyResult.payload.value).toEqual({
            error: { code: "NOT_FOUND", message: "Resolved asset has no file path and is not proxied" }
        });
    });
});
