import type { FastifyInstance } from "fastify";
import * as apiKeyAuth from "../security/api-key-auth.js";

export async function registerMetricsRoute(app: FastifyInstance): Promise<void> {
    const services = app.services;
    // Gated: the endpoint enumerates which apps and versions are hosted, cache hit ratios, and
    // GitHub call counts, and it exposes the Node heap. Free reconnaissance for anyone who asks.
    const auth = apiKeyAuth.buildApiKeyAuth({
        apiKey: services.config.adminApiKey,
        logger: services.logger
    });
    app.get(
        "/metrics",
        {
            schema: {
                tags: ["Metrics"],
                description: "Prometheus-compatible metrics",
                response: {
                    200: { type: "string" }
                }
            },
            preHandler: auth
        },
        async function (request, reply) {
            const metrics = await services.metrics.metrics();
            reply.type("text/plain; version=0.0.4; charset=utf-8").send(metrics);
        }
    );
}
