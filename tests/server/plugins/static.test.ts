import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Fastify from "fastify";
import * as fs from "node:fs";
import * as path from "node:path";
import * as staticPlugin from "../../../src/server/plugins/static.js";

describe("static plugin", function () {
    const originalNodeEnv = process.env.NODE_ENV;

    beforeEach(function () {
        process.env.NODE_ENV = "test";
    });

    afterEach(function () {
        if (originalNodeEnv !== undefined) {
            process.env.NODE_ENV = originalNodeEnv;
        } else {
            delete process.env.NODE_ENV;
        }
    });

    it("resolves dist/public when dist index exists", function () {
        const distIndex = path.resolve(process.cwd(), "dist", "public", "index.html");
        const existsSyncFn = function (targetPath: string): boolean {
            return targetPath === distIndex;
        };

        const publicDir = staticPlugin.resolvePublicDir(existsSyncFn);

        expect(publicDir).toBe(path.resolve(process.cwd(), "dist", "public"));
    });

    it("resolves public dir when dist index is missing", function () {
        const existsSyncFn = function (): boolean {
            return false;
        };

        const publicDir = staticPlugin.resolvePublicDir(existsSyncFn);

        expect(publicDir).toBe(path.resolve(process.cwd(), "public"));
    });

    it("resolves dist/public in production", function () {
        process.env.NODE_ENV = "production";

        const publicDir = staticPlugin.getPublicDir();

        expect(publicDir).toBe(path.resolve(process.cwd(), "dist", "public"));
    });

    it("registers static files", async function () {
        const app = Fastify({ logger: false });

        await staticPlugin.registerStatic(app);

        const response = await app.inject({ method: "GET", url: "/index.html" });
        expect(response.statusCode).toBe(200);
    });

    it("serves assets with correct content type", async function () {
        const publicDir = staticPlugin.getPublicDir();
        const assetsDir = path.resolve(publicDir, "assets");
        if (!fs.existsSync(assetsDir)) {
            fs.mkdirSync(assetsDir, { recursive: true });
        }
        const assetPath = path.resolve(assetsDir, "test-asset.js");
        const hadAsset = fs.existsSync(assetPath);
        fs.writeFileSync(assetPath, "console.log('test');");

        const app = Fastify({ logger: false });
        await staticPlugin.registerStatic(app);

        try {
            const response = await app.inject({ method: "GET", url: "/assets/test-asset.js" });
            expect(response.statusCode).toBe(200);
            expect(response.headers["content-type"]).toContain("javascript");
            expect(response.body).toBe("console.log('test');");
        } finally {
            if (!hadAsset) {
                fs.unlinkSync(assetPath);
            }
        }
    });
});
