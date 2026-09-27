import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";

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
            // The service pages through the cache's index rather than handing back the whole
            // history for the route to slice, so the cost of a request is the page, not the archive.
            const result = await services.release.listReleasesPage(appId, {
                page: page,
                perPage: perPage,
                includePrerelease: includePrerelease
            });
            reply.send({
                app: appId,
                page: page,
                perPage: perPage,
                total: result.total,
                releases: result.releases
            });
        }
    );

    app.get(
        "/api/releases/:app/:tag/notes",
        {
            schema: {
                tags: ["Releases"],
                description: "Release notes for one tag, as markdown",
                params: {
                    type: "object",
                    required: ["app", "tag"],
                    properties: {
                        app: { type: "string", minLength: 1 },
                        tag: { type: "string", minLength: 1 }
                    }
                }
            }
        },
        async function (request: FastifyRequest, reply: FastifyReply) {
            const services = app.services;
            const params = request.params as { app: string; tag: string };
            const release = await services.release.getReleaseByTag(params.app, params.tag);
            if (release === undefined) {
                reply.status(404).send({
                    error: { code: "NOT_FOUND", message: "No release found for that tag" }
                });
                return;
            }
            // Markdown source, not rendered HTML. Serving HTML from here would mean running an HTML
            // sanitiser in the server process - which needs a DOM implementation, tens of megabytes
            // on a 2 vCPU box, and a second sanitiser whose rules could drift from the browser's and
            // quietly become the weaker one. Consumers that want HTML already have the page; this
            // exists for the ones that do not have a browser at all.
            reply.type("text/markdown; charset=utf-8").send(release.notes);
        }
    );
}
