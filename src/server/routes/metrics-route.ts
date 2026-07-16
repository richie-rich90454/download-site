import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";

export async function registerMetricsRoute(app: FastifyInstance): Promise<void> {
    app.get(
        "/metrics",
        {
            schema: {
                tags: ["Metrics"],
                description: "Prometheus-compatible metrics",
                response: {
                    200: { type: "string" }
                }
            }
        },
        async function (request: FastifyRequest, reply: FastifyReply) {
            const services = app.services;
            const metrics = await services.metrics.metrics();
            reply.type("text/plain; version=0.0.4; charset=utf-8").send(metrics);
        }
    );
}
