import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import type { App } from "../../shared/types.js";

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
            // The single source of truth for what this mirror serves. The download page builds
            // itself from this, so adding an app on the server needs no frontend change and no
            // rebuild - the previous arrangement hardcoded the list in two places.
            const apps: App[] = app.services.config.apps;
            reply.send({ apps: apps });
        }
    );
}
