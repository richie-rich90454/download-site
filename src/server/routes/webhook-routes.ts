import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import * as webhookVerifier from "../security/webhook-verifier.js";
import type { Logger } from "../logging/logger.js";

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
    const secret = services.config.webhookSecret;
    const verify = webhookVerifier.buildWebhookVerifier({ secret: secret, logger: services.logger });

    // Registered inside an encapsulated scope so the raw-body parser applies to webhooks only.
    // GitHub signs the exact bytes it sent; re-serialising a parsed object produces different
    // bytes, so the HMAC could never match and every legitimate delivery was rejected. Parsing
    // stays scoped because every other route benefits from Fastify's JSON parser.
    await app.register(async function (scope: FastifyInstance): Promise<void> {
        scope.addContentTypeParser("application/json", { parseAs: "string" }, function (_request, payload, done) {
            done(null, payload);
        });

        scope.post(
            "/webhooks/github/release",
            {
                preHandler: verify,
                schema: {
                    tags: ["Webhooks"],
                    description: "Receive GitHub release webhook events",
                    response: {
                        200: webhookResponseSchema
                    }
                }
            },
            async function (request: FastifyRequest, reply: FastifyReply) {
                const body = parseWebhookBody(request.body, services.logger);
                if (body === undefined) {
                    reply.status(400).send({
                        error: {
                            code: "BAD_REQUEST",
                            message: "Webhook body was not valid JSON"
                        }
                    });
                    return;
                }
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
    });
}

/**
 * Parses the raw body captured by the scoped content-type parser.
 *
 * Returns undefined rather than throwing so the route can answer with a client error. A body that
 * is not raw text means the signature was computed over something other than the bytes we
 * received, so it is refused rather than trusted.
 */
export function parseWebhookBody(body: unknown, logger: Logger): WebhookBody | undefined {
    let text: string | undefined;
    if (typeof body === "string") {
        text = body;
    } else if (Buffer.isBuffer(body)) {
        text = body.toString("utf8");
    }
    if (text === undefined) {
        logger.warn("Webhook body was not raw text; the signature cannot be verified");
        return undefined;
    }
    let parsed: unknown;
    try {
        parsed = JSON.parse(text) as unknown;
    } catch (err) {
        // JSON.parse only ever throws a SyntaxError, so String() is enough here and avoids a
        // branch that no caller could reach.
        logger.warn("Webhook body was not valid JSON", { error: String(err) });
        return undefined;
    }
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
        return undefined;
    }
    return parsed as WebhookBody;
}
