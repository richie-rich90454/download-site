import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import type { Release, Asset } from "../../shared/types.js";

const appParamsSchema = {
    type: "object",
    required: ["app"],
    properties: {
        app: { type: "string", minLength: 1 }
    }
};

const updateQuerySchema = {
    type: "object",
    properties: {
        version: { type: "string" },
        current_version: { type: "string" },
        platform: { type: "string" },
        target: { type: "string" }
    }
};

const tauriUpdateQuerySchema = {
    type: "object",
    required: ["target"],
    properties: {
        target: { type: "string", minLength: 1 },
        current_version: { type: "string" },
        version: { type: "string" }
    }
};

const versionQuerySchema = {
    type: "object",
    properties: {
        version: { type: "string" },
        current_version: { type: "string" }
    }
};

const updateResponseSchema = {
    type: "object",
    properties: {
        version: { type: "string" },
        publishedAt: { type: "string" },
        releaseNotes: { type: "string" },
        assets: {
            type: "array",
            items: {
                type: "object",
                properties: {
                    name: { type: "string" },
                    size: { type: "number" },
                    url: { type: "string" },
                    browserDownloadUrl: { type: "string" }
                }
            }
        }
    }
};

const tauriV1ResponseSchema = {
    type: "object",
    properties: {
        version: { type: "string" },
        notes: { type: "string" },
        pub_date: { type: "string" },
        signature: { type: "string" },
        url: { type: "string" }
    }
};

const tauriV2ResponseSchema = {
    type: "object",
    properties: {
        version: { type: "string" },
        notes: { type: "string" },
        pub_date: { type: "string" },
        platforms: {
            type: "object",
            additionalProperties: {
                type: "object",
                properties: {
                    signature: { type: "string" },
                    url: { type: "string" }
                }
            }
        }
    }
};

const genericUpdateResponseSchema = {
    type: "object",
    properties: {
        version: { type: "string" },
        notes: { type: "string" },
        pubDate: { type: "string" },
        platforms: {
            type: "object",
            additionalProperties: {
                type: "object",
                properties: {
                    signature: { type: "string" },
                    url: { type: "string" }
                }
            }
        }
    }
};

const squirrelResponseSchema = {
    type: "object",
    properties: {
        url: { type: "string" },
        name: { type: "string" },
        notes: { type: "string" },
        pub_date: { type: "string" }
    }
};

interface UpdateQuery {
    version?: string;
    current_version?: string;
    platform?: string;
    target?: string;
}

interface TauriUpdateQuery {
    target: string;
    current_version?: string;
    version?: string;
}

interface VersionQuery {
    version?: string;
    current_version?: string;
}

export async function registerUpdateRoutes(app: FastifyInstance): Promise<void> {
    app.get(
        "/api/update/:app",
        {
            schema: {
                tags: ["Updates"],
                description: "Default update endpoint returning release metadata and asset links",
                params: appParamsSchema,
                querystring: updateQuerySchema,
                response: {
                    200: updateResponseSchema
                }
            }
        },
        async function (request: FastifyRequest, reply: FastifyReply) {
            const services = app.services;
            const params = request.params as { app: string };
            const appId = params.app;
            const query = request.query as UpdateQuery;
            const release = await resolveRelease(services.release, appId, query.version);
            if (release === undefined) {
                reply.status(404).send({ error: { code: "NOT_FOUND", message: "No release found" } });
                return;
            }
            const assets = buildAssetLinks(services.download, appId, release);
            reply.send({
                version: release.tag,
                publishedAt: release.publishedAt,
                releaseNotes: release.notes,
                assets: assets
            });
        }
    );

    app.get(
        "/api/update/tauri/:app",
        {
            schema: {
                tags: ["Updates"],
                description: "Tauri v1 updater endpoint",
                params: appParamsSchema,
                querystring: tauriUpdateQuerySchema,
                response: {
                    200: tauriV1ResponseSchema
                }
            }
        },
        async function (request: FastifyRequest, reply: FastifyReply) {
            const services = app.services;
            const params = request.params as { app: string };
            const appId = params.app;
            const query = request.query as TauriUpdateQuery;
            const result = await services.tauriUpdater.getV1Update({
                appId: appId,
                currentVersion: query.current_version,
                target: query.target
            });
            sendUpdaterResult(reply, result);
        }
    );

    app.get(
        "/api/update/tauri-v2/:app",
        {
            schema: {
                tags: ["Updates"],
                description: "Tauri v2 updater endpoint",
                params: appParamsSchema,
                querystring: versionQuerySchema,
                response: {
                    200: tauriV2ResponseSchema
                }
            }
        },
        async function (request: FastifyRequest, reply: FastifyReply) {
            const services = app.services;
            const params = request.params as { app: string };
            const appId = params.app;
            const query = request.query as VersionQuery;
            const result = await services.tauriUpdater.getV2Update({
                appId: appId,
                currentVersion: query.current_version !== undefined ? query.current_version : query.version
            });
            sendUpdaterResult(reply, result);
        }
    );

    app.get(
        "/api/update/generic/:app",
        {
            schema: {
                tags: ["Updates"],
                description: "Generic JSON updater endpoint",
                params: appParamsSchema,
                querystring: versionQuerySchema,
                response: {
                    200: genericUpdateResponseSchema
                }
            }
        },
        async function (request: FastifyRequest, reply: FastifyReply) {
            const services = app.services;
            const params = request.params as { app: string };
            const appId = params.app;
            const query = request.query as VersionQuery;
            const result = await services.genericUpdater.getUpdate({
                appId: appId,
                currentVersion: query.current_version !== undefined ? query.current_version : query.version
            });
            sendUpdaterResult(reply, result);
        }
    );

    app.get(
        "/api/update/squirrel/:app",
        {
            schema: {
                tags: ["Updates"],
                description: "Squirrel.Windows updater endpoint",
                params: appParamsSchema,
                querystring: versionQuerySchema,
                response: {
                    200: squirrelResponseSchema
                }
            }
        },
        async function (request: FastifyRequest, reply: FastifyReply) {
            const services = app.services;
            const params = request.params as { app: string };
            const appId = params.app;
            const query = request.query as VersionQuery;
            const result = await services.squirrelUpdater.getUpdate({
                appId: appId,
                currentVersion: query.current_version !== undefined ? query.current_version : query.version
            });
            sendUpdaterResult(reply, result);
        }
    );

    app.get(
        "/api/update/sparkle/:app",
        {
            schema: {
                tags: ["Updates"],
                description: "Sparkle appcast endpoint",
                params: appParamsSchema,
                querystring: versionQuerySchema,
                response: {
                    200: { type: "string" }
                }
            }
        },
        async function (request: FastifyRequest, reply: FastifyReply) {
            const services = app.services;
            const params = request.params as { app: string };
            const appId = params.app;
            const query = request.query as VersionQuery;
            const result = await services.sparkleUpdater.getAppcast({
                appId: appId,
                currentVersion: query.current_version !== undefined ? query.current_version : query.version
            });
            if (result.contentType !== undefined) {
                reply.type(result.contentType);
            }
            sendUpdaterResult(reply, result);
        }
    );
}

async function resolveRelease(
    releaseService: {
        getLatestRelease(appId: string, includePrerelease: boolean): Promise<Release | undefined>;
        getReleaseByTag(appId: string, tag: string): Promise<Release | undefined>;
    },
    appId: string,
    version?: string
): Promise<Release | undefined> {
    if (version !== undefined && version.length > 0) {
        return releaseService.getReleaseByTag(appId, version);
    }
    return releaseService.getLatestRelease(appId, false);
}

function buildAssetLinks(
    downloadService: { buildAssetUrl(appId: string, version: string, assetName: string): string },
    appId: string,
    release: Release
): Array<{ name: string; size: number; url: string; browserDownloadUrl: string }> {
    const result: Array<{ name: string; size: number; url: string; browserDownloadUrl: string }> = [];
    for (let i = 0; i < release.assets.length; i = i + 1) {
        const asset: Asset = release.assets[i];
        result.push({
            name: asset.name,
            size: asset.size,
            url: downloadService.buildAssetUrl(appId, release.tag, asset.name),
            browserDownloadUrl: asset.browserDownloadUrl
        });
    }
    return result;
}

function sendUpdaterResult(reply: FastifyReply, result: { status: number; body: unknown; contentType?: string }): void {
    if (result.status === 204) {
        reply.status(204).send();
        return;
    }
    if (result.status >= 400) {
        reply.status(result.status).send(result.body);
        return;
    }
    reply.status(result.status).send(result.body);
}
