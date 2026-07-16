import pino from "pino";
import * as logger from "./logger.js";

export class PinoLogger implements logger.Logger {
    private readonly pinoLogger: pino.Logger;

    constructor(level: string) {
        const options: pino.LoggerOptions = {
            level: level,
            redact: {
                paths: [
                    "req.headers.authorization",
                    "headers.authorization",
                    "req.headers.cookie",
                    "headers.cookie",
                    "token",
                    "github.token",
                    "github.privateKey",
                    "privateKey"
                ],
                remove: true
            }
        };
        this.pinoLogger = pino(options);
    }

    debug(message: string, meta?: Record<string, unknown>): void {
        this.log("debug", message, meta);
    }

    info(message: string, meta?: Record<string, unknown>): void {
        this.log("info", message, meta);
    }

    warn(message: string, meta?: Record<string, unknown>): void {
        this.log("warn", message, meta);
    }

    error(message: string, meta?: Record<string, unknown>): void {
        this.log("error", message, meta);
    }

    private log(level: pino.Level, message: string, meta?: Record<string, unknown>): void {
        if (meta !== undefined) {
            this.pinoLogger[level](meta, message);
        } else {
            this.pinoLogger[level](message);
        }
    }
}
