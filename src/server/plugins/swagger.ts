import * as fastifySwagger from "@fastify/swagger";
import * as fastifyApiReference from "@scalar/fastify-api-reference";
import type { FastifyInstance } from "fastify";
import type { ServerConfig } from "../config/config.js";
import type { Logger } from "../logging/logger.js";
import * as apiKeyAuth from "../security/api-key-auth.js";

export const OPENAPI_JSON_PATH = "/openapi.json";

/**
 * Registers the OpenAPI document and a self-hosted API reference.
 *
 * The reference is rendered by Scalar from our own origin, so there is no third-party script
 * fetched at runtime and no CDN dependency. It replaced swagger-ui, which was served
 * unauthenticated in every environment and published the whole API surface - including the
 * `x-admin-api-key` header name and every admin route - to anyone who asked.
 *
 * Behind the admin key the reference is useful; in front of a public mirror it is reconnaissance.
 * The raw OpenAPI JSON stays available for code generation, also behind the key.
 */
export async function registerSwagger(app: FastifyInstance, config: ServerConfig, logger: Logger): Promise<void> {
    await app.register(fastifySwagger.default, {
        openapi: {
            info: {
                title: "Download Server API",
                description: "Self-hosted GitHub release mirror and software update server.",
                version: "1.0.0"
            },
            servers: [
                {
                    url: "/"
                }
            ],
            tags: [
                { name: "Health", description: "Health probes" },
                { name: "Releases", description: "Release metadata" },
                { name: "Updates", description: "Updater endpoints" },
                { name: "Downloads", description: "Asset downloads" },
                { name: "Admin", description: "Administrative operations" },
                { name: "Webhooks", description: "Webhook receivers" },
                { name: "Metrics", description: "Prometheus metrics" }
            ]
        }
    });

    const auth = apiKeyAuth.buildApiKeyAuth({ apiKey: config.adminApiKey, logger: logger });

    app.get(OPENAPI_JSON_PATH, { preHandler: auth }, async function (request, reply) {
        reply.send(app.swagger());
    });

    await app.register(fastifyApiReference.default, {
        routePrefix: "/docs",
        hooks: {
            preHandler: auth
        }
    });
}
