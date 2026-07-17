import { describe, it, expect, vi, beforeEach } from "vitest";
import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import * as adminRoutes from "../../../src/server/routes/admin-routes.js";
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
        post: function (path: string, options: unknown, handler: unknown): void {
            routes.push({ method: "post", path: path, options: options, handler: handler });
        }
    } as unknown as FastifyInstance;
    return { app: app, routes: routes };
}

function createRequest(body: Record<string, unknown>): FastifyRequest {
    return {
        params: {},
        query: {},
        headers: {},
        body: body
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

vi.mock("../../../src/server/security/api-key-auth.js", function () {
    return {
        buildApiKeyAuth: function () {
            return function (_request: FastifyRequest, _reply: FastifyReply, done: () => void): void {
                done();
            };
        }
    };
});

describe("registerAdminRoutes", function () {
    let release: {
        warmCache: ReturnType<typeof vi.fn>;
        refreshReleases: ReturnType<typeof vi.fn>;
        refreshReleaseByTag: ReturnType<typeof vi.fn>;
        getReleaseByTag: ReturnType<typeof vi.fn>;
    };
    let metadataCache: {
        invalidateAll: ReturnType<typeof vi.fn>;
    };
    let assetCache: {
        purge: ReturnType<typeof vi.fn>;
        getAssetPath: ReturnType<typeof vi.fn>;
    };

    beforeEach(function () {
        release = {
            warmCache: vi.fn(),
            refreshReleases: vi.fn(),
            refreshReleaseByTag: vi.fn(),
            getReleaseByTag: vi.fn()
        };
        metadataCache = {
            invalidateAll: vi.fn()
        };
        assetCache = {
            purge: vi.fn(),
            getAssetPath: vi.fn()
        };
    });

    function buildServices() {
        return {
            release: release,
            metadataCache: metadataCache,
            assetCache: assetCache,
            logger: new SilentLogger()
        } as unknown as Services;
    }

    function findHandler(routes: RouteRegistration[], path: string) {
        const route = routes.find(function (r) {
            return r.path === path;
        });
        if (route === undefined) {
            throw new Error("Route not found: " + path);
        }
        return route.handler as (request: FastifyRequest, reply: FastifyReply) => Promise<void>;
    }

    it("purges cache without body", async function () {
        const services = buildServices();
        const context = createFakeApp(services);
        await adminRoutes.registerAdminRoutes(context.app);
        const handler = findHandler(context.routes, "/admin/cache/purge");
        const replyResult = createReply();

        await handler(createRequest({}), replyResult.reply as unknown as FastifyReply);

        expect(replyResult.statusCode.value).toBe(0);
        expect(replyResult.payload.value).toEqual({ success: true });
        expect(metadataCache.invalidateAll).toHaveBeenCalled();
    });

    it("refreshes releases for an app", async function () {
        const services = buildServices();
        const context = createFakeApp(services);
        await adminRoutes.registerAdminRoutes(context.app);
        const handler = findHandler(context.routes, "/admin/cache/refresh");
        release.refreshReleases.mockResolvedValue([]);
        const replyResult = createReply();

        await handler(createRequest({ app: "app1" }), replyResult.reply as unknown as FastifyReply);

        expect(release.refreshReleases).toHaveBeenCalledWith("app1");
        expect(replyResult.payload.value).toEqual({ success: true });
    });

    it("refreshes a single release by tag", async function () {
        const services = buildServices();
        const context = createFakeApp(services);
        await adminRoutes.registerAdminRoutes(context.app);
        const handler = findHandler(context.routes, "/admin/cache/refresh");
        release.refreshReleaseByTag.mockResolvedValue(undefined);
        const replyResult = createReply();

        await handler(createRequest({ app: "app1", tag: "v1.0.0" }), replyResult.reply as unknown as FastifyReply);

        expect(release.refreshReleaseByTag).toHaveBeenCalledWith("app1", "v1.0.0");
        expect(replyResult.payload.value).toEqual({ success: true });
    });

    it("warms cache for all apps when app is omitted", async function () {
        const services = buildServices();
        const context = createFakeApp(services);
        await adminRoutes.registerAdminRoutes(context.app);
        const handler = findHandler(context.routes, "/admin/cache/refresh");
        release.warmCache.mockResolvedValue(undefined);
        const replyResult = createReply();

        await handler(createRequest({}), replyResult.reply as unknown as FastifyReply);

        expect(metadataCache.invalidateAll).toHaveBeenCalled();
        expect(release.warmCache).toHaveBeenCalled();
        expect(replyResult.payload.value).toEqual({ success: true });
    });

    it("redownloads a single asset", async function () {
        const services = buildServices();
        const context = createFakeApp(services);
        await adminRoutes.registerAdminRoutes(context.app);
        const handler = findHandler(context.routes, "/admin/assets/redownload");
        release.getReleaseByTag.mockResolvedValue({
            tag: "v1.0.0",
            assets: [{ name: "app.exe", size: 100, browserDownloadUrl: "http://example.com/app.exe" }]
        });
        assetCache.getAssetPath.mockResolvedValue({ filePath: "/cache/app.exe" });
        const replyResult = createReply();

        await handler(
            createRequest({ app: "app1", version: "v1.0.0", asset: "app.exe" }),
            replyResult.reply as unknown as FastifyReply
        );

        expect(assetCache.purge).toHaveBeenCalledWith("app1", "v1.0.0", "app.exe");
        expect(assetCache.getAssetPath).toHaveBeenCalled();
        expect(replyResult.payload.value).toEqual({ success: true });
    });

    it("returns 404 when redownload release is not found", async function () {
        const services = buildServices();
        const context = createFakeApp(services);
        await adminRoutes.registerAdminRoutes(context.app);
        const handler = findHandler(context.routes, "/admin/assets/redownload");
        release.getReleaseByTag.mockResolvedValue(undefined);
        const replyResult = createReply();

        await handler(createRequest({ app: "app1", version: "v1.0.0" }), replyResult.reply as unknown as FastifyReply);

        expect(replyResult.statusCode.value).toBe(404);
        expect(replyResult.payload.value).toEqual({ error: { code: "NOT_FOUND", message: "Release not found" } });
    });
});
