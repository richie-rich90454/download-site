import * as logger from "../../src/server/logging/logger.js";

export class SilentLogger implements logger.Logger {
    debug(): void {
        // no-op
    }

    info(): void {
        // no-op
    }

    warn(): void {
        // no-op
    }

    error(): void {
        // no-op
    }
}

export interface LogEntry {
    level: "debug" | "info" | "warn" | "error";
    message: string;
    context: Record<string, unknown> | undefined;
}

/**
 * Captures log output so a test can assert on the specific branch taken, rather than inferring
 * it from an externally visible side effect.
 */
export class RecordingLogger implements logger.Logger {
    readonly entries: LogEntry[] = [];

    private record(level: "debug" | "info" | "warn" | "error", message: string, context?: unknown): void {
        this.entries.push({
            level: level,
            message: message,
            context: context !== undefined ? (context as Record<string, unknown>) : undefined
        });
    }

    debug(message: string, context?: unknown): void {
        this.record("debug", message, context);
    }

    info(message: string, context?: unknown): void {
        this.record("info", message, context);
    }

    warn(message: string, context?: unknown): void {
        this.record("warn", message, context);
    }

    error(message: string, context?: unknown): void {
        this.record("error", message, context);
    }

    messages(level: "debug" | "info" | "warn" | "error"): string[] {
        return this.entries
            .filter(function (entry) {
                return entry.level === level;
            })
            .map(function (entry) {
                return entry.message;
            });
    }
}
