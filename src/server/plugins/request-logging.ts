import * as crypto from "node:crypto";
import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import type { Logger } from "../logging/logger.js";

export async function registerRequestLogging(app: FastifyInstance, logger: Logger): Promise<void> {
    app.addHook("onRequest", function (request: FastifyRequest, reply: FastifyReply, done: () => void) {
        const id = request.headers["x-request-id"] as string | undefined;
        const requestId = id !== undefined && id.length > 0 ? id : crypto.randomUUID();
        request.id = requestId;
        reply.header("x-request-id", requestId);
        logger.debug("Request started", {
            requestId: requestId,
            method: request.method,
            url: request.url
        });
        done();
    });

    app.addHook("onResponse", function (request: FastifyRequest, reply: FastifyReply, done: () => void) {
        logger.info("Request completed", {
            requestId: request.id,
            method: request.method,
            url: request.url,
            statusCode: reply.statusCode,
            responseTime: reply.elapsedTime
        });
        done();
    });
}
