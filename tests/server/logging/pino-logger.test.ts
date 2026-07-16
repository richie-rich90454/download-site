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
import { PinoLogger } from "../../../src/server/logging/pino-logger.js";

describe("PinoLogger", function () {
    beforeEach(function () {
        vi.clearAllMocks();
    });

    afterEach(function () {
        vi.clearAllMocks();
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
