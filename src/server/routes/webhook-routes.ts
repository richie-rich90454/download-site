import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import * as webhookVerifier from "../security/webhook-verifier.js";

const webhookBodySchema = {
    type: "object",
    properties: {
        action: { type: "string" },
        release: {
            type: "object",
            properties: {
                tag_name: { type: "string" }
            }
        },
        repository: {
            type: "object",
            properties: {
                full_name: { type: "string" }
            }
        }
    }
};

const webhookResponseSchema = {
    type: "object",
    properties: {
        success: { type: "boolean" }
    }
};

interface WebhookBody {
    action?: string;
    release?: {
        tag_name?: string;
    };
    repository?: {
        full_name?: string;
    };
}

export async function registerWebhookRoutes(app: FastifyInstance): Promise<void> {
    const services = app.services;
    const secret = process.env.WEBHOOK_SECRET;
    const verify = webhookVerifier.buildWebhookVerifier({ secret: secret, logger: services.logger });

    app.post(
        "/webhooks/github/release",
        {
            preHandler: verify,
            schema: {
                tags: ["Webhooks"],
                description: "Receive GitHub release webhook events",
                body: webhookBodySchema,
                response: {
                    200: webhookResponseSchema
                }
            }
        },
        async function (request: FastifyRequest, reply: FastifyReply) {
            const body = request.body as WebhookBody;
            services.logger.info("GitHub release webhook received", {
                action: body.action,
                repository: body.repository !== undefined ? body.repository.full_name : undefined,
                tag: body.release !== undefined ? body.release.tag_name : undefined
            });
            const repoFullName = body.repository !== undefined ? body.repository.full_name : undefined;
            if (repoFullName !== undefined) {
                for (let i = 0; i < services.config.apps.length; i = i + 1) {
                    const app = services.config.apps[i];
                    if (app.repo === repoFullName) {
                        if (body.release !== undefined && body.release.tag_name !== undefined) {
                            services.metadataCache.invalidateTag(app.id, body.release.tag_name);
                        } else {
                            services.metadataCache.invalidateApp(app.id);
                        }
                    }
                }
            }
            reply.send({ success: true });
        }
    );
}
