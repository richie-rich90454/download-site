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
        const publicDir = staticPlugin.getPublicDir();

        expect(publicDir).toBe(path.resolve(process.cwd(), "dist", "public"));
    });

    it("resolves public dir when dist index is missing", function () {
        const distIndex = path.resolve(process.cwd(), "dist", "public", "index.html");
        const backupPath = distIndex + ".bak";
        const hadDistIndex = fs.existsSync(distIndex);
        if (hadDistIndex) {
            fs.renameSync(distIndex, backupPath);
        }
        try {
            const publicDir = staticPlugin.getPublicDir();

            expect(publicDir).toBe(path.resolve(process.cwd(), "public"));
        } finally {
            if (hadDistIndex) {
                fs.renameSync(backupPath, distIndex);
            }
        }
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
});
