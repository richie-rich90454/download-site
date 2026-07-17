import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import * as apiKeyAuth from "../security/api-key-auth.js";

const cachePurgeBodySchema = {
    type: "object",
    properties: {
        app: { type: "string" },
        version: { type: "string" },
        asset: { type: "string" }
    }
};

const cacheRefreshBodySchema = {
    type: "object",
    properties: {
        app: { type: "string" },
        tag: { type: "string" }
    }
};

const assetRedownloadBodySchema = {
    type: "object",
    required: ["app", "version"],
    properties: {
        app: { type: "string" },
        version: { type: "string" },
        asset: { type: "string" }
    }
};

const adminResponseSchema = {
    type: "object",
    properties: {
        success: { type: "boolean" }
    }
};

interface CachePurgeBody {
    app?: string;
    version?: string;
    asset?: string;
}

interface CacheRefreshBody {
    app?: string;
    tag?: string;
}

interface AssetRedownloadBody {
    app: string;
    version: string;
    asset?: string;
}

export async function registerAdminRoutes(app: FastifyInstance): Promise<void> {
    const services = app.services;
    const adminKey = process.env.ADMIN_API_KEY;
    const auth = apiKeyAuth.buildApiKeyAuth({ apiKey: adminKey, logger: services.logger });

    app.post(
        "/admin/cache/purge",
        {
            preHandler: auth,
            schema: {
                tags: ["Admin"],
                description: "Purge metadata and asset caches",
                body: cachePurgeBodySchema,
                response: {
                    200: adminResponseSchema
                }
            }
        },
        async function (request: FastifyRequest, reply: FastifyReply) {
            const body = request.body as CachePurgeBody;
            services.assetCache.purge(body.app, body.version, body.asset);
            if (body.app !== undefined && body.version === undefined) {
                services.metadataCache.invalidateApp(body.app);
            } else if (body.app !== undefined && body.version !== undefined) {
                services.metadataCache.invalidateTag(body.app, body.version);
            } else {
                services.metadataCache.invalidateAll();
            }
            services.logger.info("Cache purge executed by admin", {
                app: body.app,
                version: body.version,
                asset: body.asset
            });
            reply.send({ success: true });
        }
    );

    app.post(
        "/admin/cache/refresh",
        {
            preHandler: auth,
            schema: {
                tags: ["Admin"],
                description: "Refresh metadata cache from GitHub",
                body: cacheRefreshBodySchema,
                response: {
                    200: adminResponseSchema
                }
            }
        },
        async function (request: FastifyRequest, reply: FastifyReply) {
            const body = request.body as CacheRefreshBody;
            if (body.app === undefined) {
                services.metadataCache.invalidateAll();
                await services.release.warmCache();
                services.logger.info("Metadata cache refreshed for all apps by admin");
            } else if (body.tag !== undefined) {
                await services.release.refreshReleaseByTag(body.app, body.tag);
                services.logger.info("Release refreshed by admin", { app: body.app, tag: body.tag });
            } else {
                await services.release.refreshReleases(body.app);
                services.logger.info("Releases refreshed by admin", { app: body.app });
            }
            reply.send({ success: true });
        }
    );

    app.post(
        "/admin/assets/redownload",
        {
            preHandler: auth,
            schema: {
                tags: ["Admin"],
                description: "Purge and redownload cached assets",
                body: assetRedownloadBodySchema,
                response: {
                    200: adminResponseSchema
                }
            }
        },
        async function (request: FastifyRequest, reply: FastifyReply) {
            const body = request.body as AssetRedownloadBody;
            const release = await services.release.getReleaseByTag(body.app, body.version);
            if (release === undefined) {
                reply.status(404).send({ error: { code: "NOT_FOUND", message: "Release not found" } });
                return;
            }
            const assets =
                body.asset !== undefined
                    ? [body.asset]
                    : release.assets.map(function (a) {
                          return a.name;
                      });
            for (let i = 0; i < assets.length; i = i + 1) {
                const assetName = assets[i];
                const asset = release.assets.find(function (a) {
                    return a.name === assetName;
                });
                if (asset === undefined) {
                    reply.status(404).send({ error: { code: "NOT_FOUND", message: "Asset not found: " + assetName } });
                    return;
                }
                services.assetCache.purge(body.app, body.version, assetName);
                await services.assetCache.getAssetPath(body.app, body.version, asset);
            }
            services.logger.info("Assets redownloaded by admin", {
                app: body.app,
                version: body.version,
                assets: assets
            });
            reply.send({ success: true });
        }
    );
}
