import * as fastifyRateLimit from "@fastify/rate-limit";
import type { FastifyInstance } from "fastify";
import type { ServerConfig } from "../config/config.js";

export async function registerRateLimit(app: FastifyInstance, config: ServerConfig): Promise<void> {
    await app.register(fastifyRateLimit.default, {
        max: config.rateLimits.max,
        timeWindow: config.rateLimits.timeWindow
    });
}
