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

/**
 * The HTML page to serve, or undefined when there is not one.
 *
 * Two candidates, and the order matters. In production only the built page exists and it is the
 * only thing that may be served. Outside production the built page is preferred when it is there,
 * because running the server against a stale build should be obvious rather than silent. The
 * repository root is the last resort: it holds the Vite entry, whose script tag points at
 * /src/public/script.ts for the dev server to transform. It is a single named file, never a
 * directory - widening the static root to the repository would expose .env and the sources.
 */
export function resolveIndexPath(existsSyncFn?: (targetPath: string) => boolean): string | undefined {
    const checkExists = existsSyncFn !== undefined ? existsSyncFn : fs.existsSync;
    const built = path.resolve(resolvePublicDir(checkExists), "index.html");
    if (checkExists(built)) {
        return built;
    }
    if (isProduction()) {
        return undefined;
    }
    const viteEntry = path.resolve(process.cwd(), "index.html");
    if (checkExists(viteEntry)) {
        return viteEntry;
    }
    return undefined;
}

export { resolvePublicDir };

export async function registerStatic(app: FastifyInstance, root?: string): Promise<void> {
    // The root is injectable so a test can register against a directory it controls. Deriving it
    // from the presence of a build artifact otherwise makes the result depend on whether anyone
    // has run a build, which is not a property worth asserting on.
    const publicDir = root !== undefined ? root : resolvePublicDir();
    await app.register(fastifyStatic.default, {
        root: publicDir,
        wildcard: true
    });
}
