import pino from "pino";
import * as logger from "./logger.js";

/**
 * Whether to human-read the log stream.
 *
 * Pretty output costs a worker thread and produces lines no log collector can parse. In production
 * the answer is always no; the escape hatch exists so a developer can turn it off, or an operator
 * debugging a container can turn it on, without a rebuild.
 */
export function shouldPrettyPrint(env: Record<string, string | undefined>): boolean {
    const override = env.LOG_PRETTY;
    if (override !== undefined) {
        return override === "true";
    }
    return env.NODE_ENV !== "production";
}

export class PinoLogger implements logger.Logger {
    private readonly pinoLogger: pino.Logger;

    constructor(level: string, env?: Record<string, string | undefined>) {
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
        if (shouldPrettyPrint(env !== undefined ? env : process.env)) {
            options.transport = {
                target: "pino-pretty",
                options: {
                    colorize: true,
                    singleLine: true,
                    translateTime: "SYS:standard",
                    ignore: "pid,hostname"
                }
            };
        }
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
