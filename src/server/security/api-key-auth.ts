import type { FastifyRequest, FastifyReply } from "fastify";
import type { Logger } from "../logging/logger.js";

export interface ApiKeyAuthOptions {
    apiKey: string | undefined;
    logger: Logger;
}

export function buildApiKeyAuth(options: ApiKeyAuthOptions) {
    return function (request: FastifyRequest, reply: FastifyReply, done: () => void): void {
        const header = request.headers["x-admin-api-key"];
        const providedKey = Array.isArray(header) ? header[0] : header;
        if (options.apiKey === undefined || options.apiKey.length === 0) {
            options.logger.warn("Admin endpoint disabled: ADMIN_API_KEY not configured", {
                path: request.url,
                method: request.method
            });
            reply.status(403).send({
                error: {
                    code: "ADMIN_DISABLED",
                    message: "Admin endpoints are disabled"
                }
            });
            return;
        }
        if (providedKey === undefined || providedKey.length === 0) {
            options.logger.warn("Admin request missing API key", {
                path: request.url,
                method: request.method
            });
            reply.status(401).send({
                error: {
                    code: "UNAUTHORIZED",
                    message: "Missing API key"
                }
            });
            return;
        }
        if (providedKey !== options.apiKey) {
            options.logger.warn("Admin request invalid API key", {
                path: request.url,
                method: request.method
            });
            reply.status(401).send({
                error: {
                    code: "UNAUTHORIZED",
                    message: "Invalid API key"
                }
            });
            return;
        }
        options.logger.info("Admin request authorized", {
            path: request.url,
            method: request.method
        });
        done();
    };
}
