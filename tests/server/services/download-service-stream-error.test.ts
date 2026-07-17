import { describe, it, expect, vi } from "vitest";
import * as fs from "node:fs";
import * as http from "node:http";
import * as path from "node:path";
import * as stream from "node:stream";
import * as downloadService from "../../../src/server/services/download-service.js";
import * as metrics from "../../../src/server/telemetry/metrics.js";
import * as platform from "../../../src/server/platform/platform-detector.js";
import { SilentLogger } from "../test-helpers.js";

const sharedStream = new stream.PassThrough();
vi.mock("node:fs", function () {
    return {
        statSync: function () {
            return { size: 4 };
        },
        createReadStream: function () {
            return sharedStream;
        }
    };
});

describe("DownloadService stream error", function () {
    function createServiceAndReply() {
        const service = new downloadService.DownloadService(
            undefined as unknown as import("../../../src/server/services/release-service.js").ReleaseService,
            undefined as unknown as import("../../../src/server/cache/asset-cache.js").AssetCacheService,
            new platform.DefaultPlatformDetector(),
            new metrics.MetricsService(),
            new SilentLogger(),
            "http://localhost:3000"
        );
        const raw = new http.ServerResponse({ method: "GET", url: "/" } as http.IncomingMessage);
        const reply = {
            hijack: function () {
                // no-op
            },
            raw: raw
        };
        return { service: service, reply: reply, raw: raw };
    }

    it("destroys response on stream error", async function () {
        const setup = createServiceAndReply();
        const service = setup.service;
        const reply = setup.reply;
        const raw = setup.raw;
        let destroyed = false;
        raw.destroy = function () {
            destroyed = true;
            return raw;
        };

        service.serveFile(
            path.join("/tmp", "error.exe"),
            "error.exe",
            reply as unknown as import("fastify").FastifyReply
        );
        const errorStream = fs.createReadStream("/tmp/error.exe") as unknown as stream.PassThrough;
        errorStream.emit("error", new Error("read failure"));

        await new Promise(function (resolve) {
            setTimeout(resolve, 50);
        });
        expect(destroyed).toBe(true);
    });

    it("does not destroy response when already ended", async function () {
        const setup = createServiceAndReply();
        const service = setup.service;
        const reply = setup.reply;
        const raw = setup.raw;
        Object.defineProperty(raw, "writableEnded", { value: true, writable: false });
        let destroyed = false;
        raw.destroy = function () {
            destroyed = true;
            return raw;
        };

        service.serveFile(
            path.join("/tmp", "error.exe"),
            "error.exe",
            reply as unknown as import("fastify").FastifyReply
        );
        const errorStream = fs.createReadStream("/tmp/error.exe") as unknown as stream.PassThrough;
        errorStream.emit("error", new Error("read failure"));

        await new Promise(function (resolve) {
            setTimeout(resolve, 50);
        });
        expect(destroyed).toBe(false);
    });
});
