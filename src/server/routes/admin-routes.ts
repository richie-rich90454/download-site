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

const cachePurgeResponseSchema = {
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
                    200: cachePurgeResponseSchema
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
}
