import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import type { Release } from "../../shared/types.js";

const appParamsSchema = {
    type: "object",
    required: ["app"],
    properties: {
        app: { type: "string", minLength: 1 }
    }
};

const releaseListQuerySchema = {
    type: "object",
    properties: {
        page: { type: "integer", minimum: 1, default: 1 },
        per_page: { type: "integer", minimum: 1, maximum: 100, default: 30 },
        include_prerelease: { type: "boolean", default: false }
    }
};

const releaseSchema = {
    type: "object",
    properties: {
        tag: { type: "string" },
        name: { type: "string" },
        notes: { type: "string" },
        publishedAt: { type: "string" },
        prerelease: { type: "boolean" },
        assets: {
            type: "array",
            items: {
                type: "object",
                properties: {
                    name: { type: "string" },
                    size: { type: "number" },
                    contentType: { type: "string" },
                    url: { type: "string" },
                    browserDownloadUrl: { type: "string" },
                    checksum: { type: "string" }
                }
            }
        }
    }
};

const releaseListResponseSchema = {
    type: "object",
    properties: {
        app: { type: "string" },
        page: { type: "integer" },
        perPage: { type: "integer" },
        total: { type: "integer" },
        releases: {
            type: "array",
            items: releaseSchema
        }
    }
};

interface ReleaseListQuery {
    page?: number;
    per_page?: number;
    include_prerelease?: boolean;
}

export async function registerReleaseRoutes(app: FastifyInstance): Promise<void> {
    app.get(
        "/api/releases/:app",
        {
            schema: {
                tags: ["Releases"],
                description: "List releases for an app",
                params: appParamsSchema,
                querystring: releaseListQuerySchema,
                response: {
                    200: releaseListResponseSchema
                }
            }
        },
        async function (request: FastifyRequest, reply: FastifyReply) {
            const services = app.services;
            const params = request.params as { app: string };
            const appId = params.app;
            const query = request.query as ReleaseListQuery;
            const page = query.page !== undefined ? query.page : 1;
            const perPage = query.per_page !== undefined ? query.per_page : 30;
            const includePrerelease = query.include_prerelease === true;
            const releases = await services.release.listReleases(appId, {
                page: page,
                perPage: perPage,
                includePrerelease: includePrerelease
            });
            const paginated = paginateReleases(releases, page, perPage);
            reply.send({
                app: appId,
                page: page,
                perPage: perPage,
                total: releases.length,
                releases: paginated
            });
        }
    );
}

function paginateReleases(releases: Release[], page: number, perPage: number): Release[] {
    const start = (page - 1) * perPage;
    const end = start + perPage;
    const result: Release[] = [];
    for (let i = start; i < releases.length && i < end; i = i + 1) {
        result.push(releases[i]);
    }
    return result;
}
