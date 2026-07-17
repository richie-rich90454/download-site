import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";

const appsResponseSchema = {
    type: "object",
    properties: {
        apps: {
            type: "array",
            items: {
                type: "object",
                properties: {
                    id: { type: "string" },
                    repo: { type: "string" },
                    name: { type: "string" }
                }
            }
        }
    }
};

export async function registerAppRoutes(app: FastifyInstance): Promise<void> {
    app.get(
        "/api/apps",
        {
            schema: {
                tags: ["Apps"],
                description: "List configured applications",
                response: {
                    200: appsResponseSchema
                }
            }
        },
        async function (_request: FastifyRequest, reply: FastifyReply) {
            reply.send({ apps: app.services.config.apps });
        }
    );
}
