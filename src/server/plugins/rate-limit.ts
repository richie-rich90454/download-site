import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import * as clientIp from "../http/client-ip.js";
import * as apiError from "../http/api-error.js";
import { GcraLimiter, defaultBudgets, type RateLimitBudgets } from "../http/rate-budget.js";
import type { ServerConfig } from "../config/config.js";

/**
 * Per-client, per-route rate limiting.
 *
 * Replaces a single global fixed window. That config had two problems behind Cloudflare: with no
 * trust proxy the socket peer is the edge node, so all visitors on that POP shared one bucket and
 * a single abuser could deny service to everyone; and the budget also covered /download, so a
 * burst of updater polls locked out real downloads.
 *
 * The limiter is a GCRA over the client identity resolved by client-ip, which only trusts
 * cf-connecting-ip when the socket peer really is Cloudflare. `trustProxy: true` is deliberately
 * not used: Cloudflare appends to X-Forwarded-For, so a client could forge the left-most entry.
 */
export async function registerRateLimit(app: FastifyInstance, config: ServerConfig): Promise<void> {
    const budgets = resolveBudgets(config);
    const downloadLimiter = new GcraLimiter(budgets.download);
    const apiLimiter = new GcraLimiter(budgets.api);
    const adminLimiter = new GcraLimiter(budgets.admin);

    app.addHook("onRequest", function (request: FastifyRequest, reply: FastifyReply, done: () => void) {
        // Health probes and metrics are infrastructure, not end users, and must never be the
        // reason a monitoring system reports the service as down.
        if (isExempt(request)) {
            done();
            return;
        }
        const resolved = clientIp.resolveClientId(request.socket.remoteAddress, request.headers);
        const limiter = limiterFor(request, downloadLimiter, apiLimiter, adminLimiter);
        const decision = limiter.check(resolved.clientId, Date.now());
        if (decision.allowed) {
            reply.header("x-ratelimit-remaining", String(decision.remaining));
            done();
            return;
        }
        const limited = apiError.Errors.rateLimited();
        reply
            .header("retry-after", String(Math.ceil(decision.retryAfterMs / 1000)))
            .header("x-ratelimit-remaining", "0")
            .status(429)
            .send(apiError.toClientError(limited, String(request.id)));
    });
}

function isExempt(request: FastifyRequest): boolean {
    const url = request.url;
    return url.indexOf("/health") === 0 || url === "/metrics" || url.indexOf("/docs") === 0;
}

function limiterFor(
    request: FastifyRequest,
    downloadLimiter: GcraLimiter,
    apiLimiter: GcraLimiter,
    adminLimiter: GcraLimiter
): GcraLimiter {
    const url = request.url;
    if (url.indexOf("/admin") === 0 || url.indexOf("/webhooks") === 0) {
        return adminLimiter;
    }
    if (url.indexOf("/download") === 0) {
        return downloadLimiter;
    }
    return apiLimiter;
}

function resolveBudgets(config: ServerConfig): RateLimitBudgets {
    const defaults = defaultBudgets();
    const configured = config.rateLimits;
    if (configured === undefined) {
        return defaults;
    }
    const burst = configured.burst !== undefined ? configured.burst : 10;
    return {
        download: { limit: configured.max, periodMs: configured.timeWindow, burst: burst * 3 },
        api: { limit: configured.max, periodMs: configured.timeWindow, burst: burst },
        admin: { limit: Math.max(Math.floor(configured.max / 10), 1), periodMs: configured.timeWindow, burst: 2 }
    };
}
