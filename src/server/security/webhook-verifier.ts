import * as crypto from "node:crypto";
import type { FastifyRequest, FastifyReply } from "fastify";
import type { Logger } from "../logging/logger.js";

export interface WebhookVerifierOptions {
    secret: string | undefined;
    logger: Logger;
}

export function buildWebhookVerifier(options: WebhookVerifierOptions) {
    return function (request: FastifyRequest, reply: FastifyReply, done: () => void): void {
        const signatureHeader = request.headers["x-hub-signature-256"];
        const signature = Array.isArray(signatureHeader) ? signatureHeader[0] : signatureHeader;
        if (options.secret === undefined || options.secret.length === 0) {
            options.logger.warn("Webhook endpoint disabled: WEBHOOK_SECRET not configured", {
                path: request.url
            });
            reply.status(403).send({
                error: {
                    code: "WEBHOOK_DISABLED",
                    message: "Webhook endpoints are disabled"
                }
            });
            return;
        }
        if (signature === undefined || signature.length === 0) {
            options.logger.warn("Webhook request missing signature", {
                path: request.url
            });
            reply.status(401).send({
                error: {
                    code: "UNAUTHORIZED",
                    message: "Missing webhook signature"
                }
            });
            return;
        }
        const body = request.body as string | Buffer | Record<string, unknown>;
        let payload: string;
        if (typeof body === "string") {
            payload = body;
        } else if (Buffer.isBuffer(body)) {
            payload = body.toString("utf8");
        } else {
            payload = JSON.stringify(body);
        }
        const expected = "sha256=" + crypto.createHmac("sha256", options.secret).update(payload).digest("hex");
        const provided = signature;
        let match = false;
        if (provided.length === expected.length) {
            let diff = 0;
            for (let i = 0; i < provided.length; i = i + 1) {
                diff = diff | (provided.charCodeAt(i) ^ expected.charCodeAt(i));
            }
            match = diff === 0;
        }
        if (!match) {
            options.logger.warn("Webhook request invalid signature", {
                path: request.url
            });
            reply.status(401).send({
                error: {
                    code: "UNAUTHORIZED",
                    message: "Invalid webhook signature"
                }
            });
            return;
        }
        options.logger.info("Webhook request verified", {
            path: request.url
        });
        done();
    };
}
