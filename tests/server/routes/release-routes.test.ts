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
        const releaseServiceMock = { listReleasesPage: vitest.vi.fn() };
        const services = {
            release: releaseServiceMock,
            logger: new SilentLogger()
        } as unknown as Services;
        const context = createFakeApp(services);
        await releaseRoutes.registerReleaseRoutes(context.app);
        const handler = context.routes[0].handler as (request: FastifyRequest, reply: FastifyReply) => Promise<void>;
        const release = createRelease("v1.0.0");
        releaseServiceMock.listReleasesPage.mockResolvedValue({ releases: [release], total: 1 });

        const request = createRequest({ app: "app1" }, {});
        const replyResult = createReply();

        await handler(request, replyResult.reply as unknown as FastifyReply);

        vitest.expect(releaseServiceMock.listReleasesPage).toHaveBeenCalledWith("app1", {
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

    vitest.it("reports the full count while returning only the page", async function () {
        const releaseServiceMock = { listReleasesPage: vitest.vi.fn() };
        const services = {
            release: releaseServiceMock,
            logger: new SilentLogger()
        } as unknown as Services;
        const context = createFakeApp(services);
        await releaseRoutes.registerReleaseRoutes(context.app);
        const handler = context.routes[0].handler as (request: FastifyRequest, reply: FastifyReply) => Promise<void>;
        // The whole point of paging through the index: the client learns there are 412 releases
        // without the server handing it 412 releases' worth of msgpack.
        releaseServiceMock.listReleasesPage.mockResolvedValue({
            releases: [createRelease("v4.1.0")],
            total: 412
        });

        // Numbers, not strings: Fastify coerces them from the querystring schema before the
        // handler runs, and this fake skips that step.
        const request = createRequest({ app: "app1" }, { page: 2, per_page: 1 });
        const replyResult = createReply();

        await handler(request, replyResult.reply as unknown as FastifyReply);

        const body = replyResult.payload.value as Record<string, unknown>;
        vitest.expect(body.total).toBe(412);
        vitest.expect((body.releases as unknown[]).length).toBe(1);
        vitest.expect(body.page).toBe(2);
        vitest.expect(body.perPage).toBe(1);
    });
});
