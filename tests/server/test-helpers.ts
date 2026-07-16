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
