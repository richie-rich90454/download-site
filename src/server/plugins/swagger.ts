import * as fastifySwagger from "@fastify/swagger";
import * as fastifySwaggerUi from "@fastify/swagger-ui";
import type { FastifyInstance } from "fastify";

export async function registerSwagger(app: FastifyInstance): Promise<void> {
    await app.register(fastifySwagger.default, {
        openapi: {
            info: {
                title: "Download Server API",
                description: "SaaS-grade download and update server",
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
    await app.register(fastifySwaggerUi.default, {
        routePrefix: "/docs"
    });
}
