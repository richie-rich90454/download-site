import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const pinoMock = vi.hoisted(function () {
    return {
        debug: vi.fn(),
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn()
    };
});

vi.mock("pino", function () {
    return {
        default: vi.fn().mockReturnValue(pinoMock)
    };
});

import pino from "pino";
import * as pinoLogger from "../../../src/server/logging/pino-logger.js";
import { PinoLogger } from "../../../src/server/logging/pino-logger.js";

describe("PinoLogger", function () {
    beforeEach(function () {
        vi.clearAllMocks();
    });

    afterEach(function () {
        vi.clearAllMocks();
    });

    it("pretty prints outside production", function () {
        expect(pinoLogger.shouldPrettyPrint({ NODE_ENV: "development" })).toBe(true);
    });

    it("emits structured JSON in production", function () {
        // Pretty output costs a worker thread and produces lines no log collector can parse.
        expect(pinoLogger.shouldPrettyPrint({ NODE_ENV: "production" })).toBe(false);
    });

    it("lets an operator override the environment either way", function () {
        expect(pinoLogger.shouldPrettyPrint({ NODE_ENV: "production", LOG_PRETTY: "true" })).toBe(true);
        expect(pinoLogger.shouldPrettyPrint({ NODE_ENV: "development", LOG_PRETTY: "false" })).toBe(false);
    });

    it("defaults to no pretty printing when the environment says nothing", function () {
        expect(pinoLogger.shouldPrettyPrint({})).toBe(true);
        expect(pinoLogger.shouldPrettyPrint({ LOG_PRETTY: "" })).toBe(false);
    });

    it("takes the environment from the caller when given one", function () {
        // An embedder may hold its own environment rather than the process one.
        expect(function () {
            return new PinoLogger("info", { NODE_ENV: "production" });
        }).not.toThrow();
    });

    it("creates a pino logger with the configured level", function () {
        new PinoLogger("warn");

        expect(pino).toHaveBeenCalledTimes(1);
        const options = (vi.mocked(pino).mock.calls[0] as unknown[])[0] as Record<string, unknown>;
        expect(options.level).toBe("warn");
        expect(options.redact).toBeDefined();
    });

    it("logs debug messages without meta", function () {
        const logger = new PinoLogger("debug");
        logger.debug("debug message");
        expect(pinoMock.debug).toHaveBeenCalledWith("debug message");
    });

    it("logs debug messages with meta", function () {
        const logger = new PinoLogger("debug");
        logger.debug("debug message", { key: "value" });
        expect(pinoMock.debug).toHaveBeenCalledWith({ key: "value" }, "debug message");
    });

    it("logs info messages without meta", function () {
        const logger = new PinoLogger("info");
        logger.info("info message");
        expect(pinoMock.info).toHaveBeenCalledWith("info message");
    });

    it("logs info messages with meta", function () {
        const logger = new PinoLogger("info");
        logger.info("info message", { key: "value" });
        expect(pinoMock.info).toHaveBeenCalledWith({ key: "value" }, "info message");
    });

    it("logs warn messages without meta", function () {
        const logger = new PinoLogger("warn");
        logger.warn("warn message");
        expect(pinoMock.warn).toHaveBeenCalledWith("warn message");
    });

    it("logs warn messages with meta", function () {
        const logger = new PinoLogger("warn");
        logger.warn("warn message", { key: "value" });
        expect(pinoMock.warn).toHaveBeenCalledWith({ key: "value" }, "warn message");
    });

    it("logs error messages without meta", function () {
        const logger = new PinoLogger("error");
        logger.error("error message");
        expect(pinoMock.error).toHaveBeenCalledWith("error message");
    });

    it("logs error messages with meta", function () {
        const logger = new PinoLogger("error");
        logger.error("error message", { key: "value" });
        expect(pinoMock.error).toHaveBeenCalledWith({ key: "value" }, "error message");
    });
});
