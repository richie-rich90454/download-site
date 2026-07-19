import * as path from "node:path";
import * as fs from "node:fs";
import * as fastifyStatic from "@fastify/static";
import type { FastifyInstance } from "fastify";

function isProduction(): boolean {
    return process.env.NODE_ENV === "production";
}

function resolvePublicDir(existsSyncFn?: (targetPath: string) => boolean): string {
    const checkExists = existsSyncFn !== undefined ? existsSyncFn : fs.existsSync;
    const distPublic = path.resolve(process.cwd(), "dist", "public");
    const distIndex = path.resolve(distPublic, "index.html");
    if (isProduction()) {
        return distPublic;
    }
    if (checkExists(distIndex)) {
        return distPublic;
    }
    return path.resolve(process.cwd(), "public");
}

export function getPublicDir(): string {
    return resolvePublicDir();
}

export { resolvePublicDir };

export async function registerStatic(app: FastifyInstance): Promise<void> {
    const publicDir = resolvePublicDir();
    await app.register(fastifyStatic.default, {
        root: publicDir,
        wildcard: true
    });
}
