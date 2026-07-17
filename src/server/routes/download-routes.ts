import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";

const appParamsSchema = {
    type: "object",
    required: ["app"],
    properties: {
        app: { type: "string", minLength: 1 }
    }
};

const downloadQuerySchema = {
    type: "object",
    properties: {
        version: { type: "string" },
        asset: { type: "string" },
        platform: { type: "string" }
    }
};

interface DownloadQuery {
    version?: string;
    asset?: string;
    platform?: string;
}

export async function registerDownloadRoutes(app: FastifyInstance): Promise<void> {
    app.get(
        "/download/:app",
        {
            schema: {
                tags: ["Downloads"],
                description: "Download the best-matching asset for an app",
                params: appParamsSchema,
                querystring: downloadQuerySchema
            }
        },
        async function (request: FastifyRequest, reply: FastifyReply) {
            const services = app.services;
            const params = request.params as { app: string };
            const appId = params.app;
            const query = request.query as DownloadQuery;
            const userAgent = request.headers["user-agent"];
            const rangeHeader = request.headers.range;
            try {
                const result = await services.download.resolveAsset(appId, {
                    version: query.version,
                    assetName: query.asset,
                    userAgent: Array.isArray(userAgent) ? userAgent[0] : userAgent,
                    platformHint: query.platform
                });
                const range = Array.isArray(rangeHeader) ? rangeHeader[0] : rangeHeader;
                services.download.serveFile(result.filePath, result.asset.name, reply, range);
            } catch (err) {
                const message = err instanceof Error ? err.message : String(err);
                services.logger.warn("Download failed", { app: appId, error: message });
                reply.status(404).send({
                    error: {
                        code: "NOT_FOUND",
                        message: message
                    }
                });
            }
        }
    );
}
