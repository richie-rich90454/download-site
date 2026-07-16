import * as vitest from "vitest";
import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import * as releaseRoutes from "../../../src/server/routes/release-routes.js";
import type { Services } from "../../../src/server/container.js";
import type { Release } from "../../../src/shared/types.js";
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

function createRequest(params: Record<string, unknown>, query: Record<string, unknown>): FastifyRequest {
    return {
        params: params,
        query: query,
        headers: {},
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

vitest.describe("registerReleaseRoutes", function () {
    function createRelease(tag: string): Release {
        return {
            tag: tag,
            name: "Release " + tag,
            notes: "Notes for " + tag,
            publishedAt: "2024-01-15T00:00:00Z",
            prerelease: false,
            assets: [
                {
                    name: "app-windows.exe",
                    size: 100,
                    contentType: "application/octet-stream",
                    url: "http://example.com/app-windows.exe",
                    browserDownloadUrl: "http://example.com/app-windows.exe"
                }
            ]
        };
    }

    vitest.it("uses default page and perPage when query omits them", async function () {
        const releaseServiceMock = { listReleases: vitest.vi.fn() };
        const services = {
            release: releaseServiceMock,
            logger: new SilentLogger()
        } as unknown as Services;
        const context = createFakeApp(services);
        await releaseRoutes.registerReleaseRoutes(context.app);
        const handler = context.routes[0].handler as (request: FastifyRequest, reply: FastifyReply) => Promise<void>;
        const release = createRelease("v1.0.0");
        releaseServiceMock.listReleases.mockResolvedValue([release]);

        const request = createRequest({ app: "app1" }, {});
        const replyResult = createReply();

        await handler(request, replyResult.reply as unknown as FastifyReply);

        vitest.expect(releaseServiceMock.listReleases).toHaveBeenCalledWith("app1", {
            page: 1,
            perPage: 30,
            includePrerelease: false
        });
        const body = replyResult.payload.value as Record<string, unknown>;
        vitest.expect(body.app).toBe("app1");
        vitest.expect(body.page).toBe(1);
        vitest.expect(body.perPage).toBe(30);
        vitest.expect(body.total).toBe(1);
    });
});
