import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import * as apiError from "../http/api-error.js";

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

/**
 * A repeated request header arrives as an array. Taking the first is what the client meant; the
 * duplicates exist because a proxy appended one.
 */
function headerValue(value: string | string[] | undefined): string | undefined {
    if (value === undefined) {
        return undefined;
    }
    if (Array.isArray(value)) {
        return value[0];
    }
    return value;
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
            const ifNoneMatch = headerValue(request.headers["if-none-match"]);
            const ifModifiedSince = headerValue(request.headers["if-modified-since"]);
            try {
                const result = await services.download.resolveAsset(appId, {
                    version: query.version,
                    assetName: query.asset,
                    userAgent: userAgent !== undefined ? userAgent[0] : undefined,
                    platformHint: query.platform
                });
                const range = headerValue(rangeHeader);
                if (result.proxied) {
                    await services.download.proxyDownload(
                        appId,
                        result.asset,
                        result.release,
                        reply,
                        range,
                        String(request.id)
                    );
                } else if (result.filePath !== undefined) {
                    services.download.serveFile(
                        result.filePath,
                        result.asset.name,
                        reply,
                        range,
                        result.asset.checksum,
                        ifNoneMatch,
                        ifModifiedSince
                    );
                } else {
                    throw new Error("Resolved asset has no file path and is not proxied");
                }
            } catch (err) {
                // Previously every failure here was reported as 404 with the raw error message,
                // which both hid genuine 500s from monitoring and leaked internal detail.
                const safe = apiError.toSafeApiError(err);
                services.logger.warn("Download failed", {
                    app: appId,
                    requestId: String(request.id),
                    code: safe.code,
                    error: err instanceof Error ? err.message : String(err)
                });
                reply.status(safe.status).send(apiError.toClientError(safe, String(request.id)));
            }
        }
    );
}
