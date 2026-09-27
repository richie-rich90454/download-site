import type { FastifyInstance } from "fastify";
import type { Services } from "./container.js";

/**
 * How long a shutdown may spend letting in-flight requests finish.
 *
 * A drain with no deadline never ends: one slow download holds the process open indefinitely, and
 * an orchestrator that gave up waiting sends SIGKILL anyway - losing the graceful path and taking
 * temp files with it. Better to stop cleanly at a known point and say so.
 */
export const DRAIN_TIMEOUT_MS = 15000;

/** Long enough to survive a supervisor restart, short enough not to overlap two listeners. */
export const CACHE_REFRESH_INTERVAL_MS = 300000;

export interface LifecycleOptions {
    drainTimeoutMs?: number;
    refreshIntervalMs?: number;
    onExit?: (code: number) => void;
}

export interface LifecycleHandle {
    interval: ReturnType<typeof setInterval>;
    /**
     * Stops the refresh loop and removes the signal handlers.
     *
     * Needed by anything that owns the process's lifetime but not its exit - a test, or an
     * embedder that tears the server down without the process ending. Without it the handlers stay
     * bound to a closed server, and a later signal would try to drain it again.
     */
    stop: () => void;
}

/**
 * Starts periodic cache refresh and installs the signal handlers.
 */
export function startLifecycle(services: Services, app: FastifyInstance, options?: LifecycleOptions): LifecycleHandle {
    const refreshIntervalMs =
        options !== undefined && options.refreshIntervalMs !== undefined
            ? options.refreshIntervalMs
            : CACHE_REFRESH_INTERVAL_MS;
    const drainTimeoutMs =
        options !== undefined && options.drainTimeoutMs !== undefined ? options.drainTimeoutMs : DRAIN_TIMEOUT_MS;
    const exit = options !== undefined && options.onExit !== undefined ? options.onExit : defaultExit;

    warmInBackground(services);

    const interval = setInterval(function () {
        services.release.warmCache().catch(function (err) {
            services.logger.error("Periodic cache refresh failed", { error: err });
        });
    }, refreshIntervalMs);

    let shuttingDown = false;
    const shutdown = function (signal: string): Promise<void> {
        // A second signal while draining is a second request for the same thing. Acting on it would
        // close the databases underneath a request that is still reading them.
        if (shuttingDown) {
            services.logger.info("Shutdown already in progress", { signal: signal });
            return Promise.resolve();
        }
        shuttingDown = true;
        return drain(services, app, interval, signal, drainTimeoutMs, exit);
    };

    const onSigterm = function (): void {
        shutdown("SIGTERM").catch(reportShutdownFailure(services, exit));
    };
    const onSigint = function (): void {
        shutdown("SIGINT").catch(reportShutdownFailure(services, exit));
    };
    process.on("SIGTERM", onSigterm);
    process.on("SIGINT", onSigint);

    return {
        interval: interval,
        stop: function (): void {
            clearInterval(interval);
            process.removeListener("SIGTERM", onSigterm);
            process.removeListener("SIGINT", onSigint);
        }
    };
}

/**
 * Warms the cache without making startup wait for it.
 *
 * A failure is logged and swallowed on purpose: the server is already serving, and the next request
 * fetches on demand anyway. Failing the process here would undo the reason warming moved after
 * listen.
 */
export function warmInBackground(services: Services): void {
    services.release.warmCache().catch(function (err) {
        services.logger.error("Cache warm failed; serving from cache and fetching on demand", { error: err });
    });
}

/**
 * Stops accepting connections, lets in-flight requests finish, then closes the caches.
 *
 * Ordering is the whole point: `app.close()` stops new connections and waits for existing ones, so
 * the databases are still open for every request mid-read. Closing them first turns a graceful
 * restart into a scatter of failed downloads.
 *
 * The caches close even when the drain times out. A request still running past the deadline has
 * already been told the shutdown is over, and holding a connection open indefinitely helps nobody.
 */
export async function drain(
    services: Services,
    app: FastifyInstance,
    refreshInterval: ReturnType<typeof setInterval>,
    signal: string,
    drainTimeoutMs: number,
    exit: (code: number) => void
): Promise<void> {
    services.logger.info("Shutting down server", { signal: signal });
    clearInterval(refreshInterval);

    const closed = app.close();
    const timedOut = await Promise.race([
        closed.then(function () {
            return false;
        }),
        delay(drainTimeoutMs).then(function () {
            return true;
        })
    ]);

    services.metadataCache.close();
    services.assetCache.close();

    if (timedOut) {
        services.logger.warn("Drain timed out; closed caches with requests still in flight", {
            timeoutMs: drainTimeoutMs
        });
    }
    services.logger.info("Server shutdown complete");
    exit(0);
}

export function reportShutdownFailure(services: Services, exit: (code: number) => void): (err: unknown) => void {
    return function (err: unknown): void {
        services.logger.error("Shutdown failed", { error: err });
        exit(1);
    };
}

function delay(ms: number): Promise<void> {
    return new Promise(function (resolve) {
        setTimeout(resolve, ms);
    });
}

/* v8 ignore next 4 -- only reachable outside a test: a caller that omits onExit really does exit */
function defaultExit(code: number): void {
    process.exit(code);
}
