import * as fastifyCors from "@fastify/cors";
import type { FastifyInstance } from "fastify";
import type { ServerConfig } from "../config/config.js";

export async function registerCors(app: FastifyInstance, config: ServerConfig): Promise<void> {
    const origin = config.corsOrigin !== undefined ? config.corsOrigin : "*";
    await app.register(fastifyCors.default, {
        origin: origin
    });
}
