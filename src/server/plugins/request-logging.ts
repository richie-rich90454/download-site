import * as crypto from "node:crypto";
import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import type { Logger } from "../logging/logger.js";
import type { MetricsService } from "../telemetry/metrics.js";

export async function registerRequestLogging(
    app: FastifyInstance,
    logger: Logger,
    metrics: MetricsService
): Promise<void> {
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
        // Feeds http_requests_total and http_request_duration_seconds, which existed but were
        // never called and so always reported zero.
        metrics.recordHttpRequest(request.method, routeLabel(request), reply.statusCode, reply.elapsedTime / 1000);
        done();
    });
}

/**
 * Groups requests by matched route template rather than raw URL.
 *
 * Labelling on the raw path would create one time series per distinct id, tag, and query string,
 * which is the same unbounded-cardinality problem that made the version labels a leak.
 * Falls back to a coarse bucket for anything unmatched or hijacked.
 */
export function routeLabel(request: FastifyRequest): string {
    const routeOptions = request.routeOptions;
    if (routeOptions !== undefined && routeOptions.url !== undefined && routeOptions.url.length > 0) {
        return routeOptions.url;
    }
    return "unmatched";
}
