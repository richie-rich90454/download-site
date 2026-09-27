import * as crypto from "node:crypto";
import type { FastifyRequest, FastifyReply } from "fastify";
import type { Logger } from "../logging/logger.js";
import { safeSecretEqual } from "./secret-compare.js";

export interface WebhookVerifierOptions {
    secret: string | undefined;
    logger: Logger;
    /** How long a delivery id is remembered, to reject replays. Zero disables the check. */
    replayWindowMs?: number;
}

const DEFAULT_REPLAY_WINDOW_MS = 10 * 60 * 1000;
const MAX_REPLAY_ENTRIES = 4096;

/**
 * Remembers recently seen delivery ids with a bounded size.
 *
 * A captured webhook is otherwise replayable forever, and each replay is a cheap way to make the
 * next request for that release a cold fetch. The map is capped so a flood cannot grow it
 * without limit; the oldest entry is dropped once full, which is the right trade for a
 * time-window guarantee.
 */
export class ReplayGuard {
    private readonly seen: Map<string, number>;
    private readonly windowMs: number;

    constructor(windowMs: number) {
        this.seen = new Map();
        this.windowMs = windowMs;
    }

    /** Returns true when the id is new, false when it replays a delivery inside the window. */
    accept(deliveryId: string, now: number): boolean {
        this.prune(now);
        if (this.seen.has(deliveryId)) {
            return false;
        }
        this.seen.set(deliveryId, now);
        // Map preserves insertion order, so the first key is the oldest delivery. Adding one
        // entry can only push the size one over the cap, so a single eviction restores it.
        // Deleting during iteration of keys() is well defined.
        if (this.seen.size > MAX_REPLAY_ENTRIES) {
            for (const key of this.seen.keys()) {
                this.seen.delete(key);
                break;
            }
        }
        return true;
    }

    private prune(now: number): void {
        const cutoff = now - this.windowMs;
        const iterator = this.seen.keys();
        let entry = iterator.next();
        while (entry.done !== true) {
            const recordedAt = this.seen.get(entry.value);
            if (recordedAt === undefined || recordedAt < cutoff) {
                this.seen.delete(entry.value);
            }
            entry = iterator.next();
        }
    }
}

export function buildWebhookVerifier(options: WebhookVerifierOptions) {
    const replayWindowMs = options.replayWindowMs !== undefined ? options.replayWindowMs : DEFAULT_REPLAY_WINDOW_MS;
    const replayGuard = new ReplayGuard(replayWindowMs);
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
        if (!safeSecretEqual(signature, expected)) {
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
        if (replayWindowMs > 0) {
            const deliveryHeader = request.headers["x-github-delivery"];
            const deliveryId = Array.isArray(deliveryHeader) ? deliveryHeader[0] : deliveryHeader;
            if (deliveryId !== undefined && !replayGuard.accept(deliveryId, Date.now())) {
                options.logger.warn("Webhook request replayed", {
                    path: request.url,
                    delivery: deliveryId
                });
                reply.status(401).send({
                    error: {
                        code: "UNAUTHORIZED",
                        message: "Webhook delivery already processed"
                    }
                });
                return;
            }
        }
        options.logger.info("Webhook request verified", {
            path: request.url
        });
        done();
    };
}
