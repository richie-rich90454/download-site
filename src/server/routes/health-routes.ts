import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";

const healthResponseSchema = {
    type: "object",
    properties: {
        status: { type: "string" },
        ready: { type: "boolean" },
        live: { type: "boolean" },
        uptime: { type: "number" },
        checks: {
            type: "object",
            properties: {
                cacheInitialized: { type: "boolean" },
                diskSpace: {
                    type: "object",
                    properties: {
                        ok: { type: "boolean" },
                        freeBytes: { type: "number" },
                        thresholdBytes: { type: "number" }
                    }
                }
            }
        }
    }
};

export async function registerHealthRoutes(app: FastifyInstance): Promise<void> {
    app.get(
        "/health",
        {
            schema: {
                tags: ["Health"],
                description: "Overall health status",
                response: {
                    200: healthResponseSchema
                }
            }
        },
        function (request: FastifyRequest, reply: FastifyReply) {
            const services = app.services;
            reply.send(services.health.getHealth());
        }
    );

    app.get(
        "/health/ready",
        {
            schema: {
                tags: ["Health"],
                description: "Readiness probe",
                response: {
                    200: healthResponseSchema,
                    503: healthResponseSchema
                }
            }
        },
        function (request: FastifyRequest, reply: FastifyReply) {
            const services = app.services;
            const ready = services.health.isReady();
            const status = services.health.getHealth();
            reply.status(ready ? 200 : 503).send(status);
        }
    );

    app.get(
        "/health/live",
        {
            schema: {
                tags: ["Health"],
                description: "Liveness probe",
                response: {
                    200: healthResponseSchema
                }
            }
        },
        function (request: FastifyRequest, reply: FastifyReply) {
            const services = app.services;
            const status = services.health.getHealth();
            reply.status(200).send(status);
        }
    );
}
