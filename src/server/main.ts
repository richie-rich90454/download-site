import * as config from "./config/config.js";
import * as container from "./container.js";
import * as appFactory from "./app.js";
import type { Services } from "./container.js";

/**
 * How long a shutdown may spend letting in-flight requests finish.
 *
 * A drain with no deadline never ends: one slow download holds the process open indefinitely, and
 * an orchestrator that gave up waiting sends SIGKILL anyway - losing the graceful path and taking
 * temp files with it. Better to stop cleanly at a known point and report that we did.
 */
const DRAIN_TIMEOUT_MS = 15000;

/** Long enough to survive a supervisor restart, short enough not to overlap two listeners. */
const CACHE_REFRESH_INTERVAL_MS = 300000;

async function main(): Promise<void> {
    const cfg = config.loadConfig();
    const services = container.registerServices(cfg);
    const app = await appFactory.buildApp(services);

    // Listen before warming. Warming talks to GitHub, and if GitHub is slow or down the server would
    // otherwise refuse connections for as long as the fetch takes - turning an upstream problem
    // into a total outage. Requests that arrive first are served from whatever cache exists, and
    // the first read that finds nothing fetches on demand.
    await app.listen({ port: cfg.port, host: "0.0.0.0" });
    services.logger.info("Server listening", { port: cfg.port });

    warmInBackground(services);
    const refreshInterval = startRefresh(services);

    installSignalHandlers(services, app, refreshInterval);
}

/**
 * Warms the cache without making startup wait for it.
 *
 * A failure is logged and swallowed on purpose: the server is already serving, and the next request
 * fetches on demand anyway. Failing the process here would undo the reason warming moved.
 */
function warmInBackground(services: Services): void {
    services.release.warmCache().catch(function (err) {
        services.logger.error("Cache warm failed; serving from cache and fetching on demand", { error: err });
    });
}

function startRefresh(services: Services): ReturnType<typeof setInterval> {
    return setInterval(function () {
        services.release.warmCache().catch(function (err) {
            services.logger.error("Periodic cache refresh failed", { error: err });
        });
    }, CACHE_REFRESH_INTERVAL_MS);
}

function installSignalHandlers(
    services: Services,
    app: Awaited<ReturnType<typeof appFactory.buildApp>>,
    refreshInterval: ReturnType<typeof setInterval>
): void {
    let shuttingDown = false;
    const shutdown = function (signal: string): Promise<void> {
        // A second signal while draining is a second request for the same thing. Acting on it would
        // close the databases underneath a request that is still reading them.
        if (shuttingDown) {
            services.logger.info("Shutdown already in progress", { signal: signal });
            return Promise.resolve();
        }
        shuttingDown = true;
        return drain(services, app, refreshInterval, signal);
    };

    process.on("SIGTERM", function () {
        shutdown("SIGTERM").catch(function (err) {
            services.logger.error("Shutdown failed", { error: err });
            process.exit(1);
        });
    });

    process.on("SIGINT", function () {
        shutdown("SIGINT").catch(function (err) {
            services.logger.error("Shutdown failed", { error: err });
            process.exit(1);
        });
    });
}

/**
 * Stops accepting connections, lets in-flight requests finish, then closes the caches.
 *
 * Ordering is the whole point: `app.close()` stops new connections and waits for existing ones, so
 * the databases are still open for every request mid-read. Closing them first turns a graceful
 * restart into a scatter of failed downloads.
 */
async function drain(
    services: Services,
    app: Awaited<ReturnType<typeof appFactory.buildApp>>,
    refreshInterval: ReturnType<typeof setInterval>,
    signal: string
): Promise<void> {
    services.logger.info("Shutting down server", { signal: signal });
    clearInterval(refreshInterval);

    const closed = app.close();
    const timedOut = await Promise.race([
        closed.then(function () {
            return false;
        }),
        delay(DRAIN_TIMEOUT_MS).then(function () {
            return true;
        })
    ]);

    // The databases close either way. A request still running after the deadline has already been
    // told the shutdown is over, and holding a connection open indefinitely helps nobody.
    services.metadataCache.close();
    services.assetCache.close();

    if (timedOut) {
        services.logger.warn("Drain timed out; closed caches with requests still in flight", {
            timeoutMs: DRAIN_TIMEOUT_MS
        });
    }
    services.logger.info("Server shutdown complete");
    process.exit(0);
}

function delay(ms: number): Promise<void> {
    return new Promise(function (resolve) {
        setTimeout(resolve, ms);
    });
}

main().catch(function (err) {
    console.error("Failed to start server:", err);
    process.exit(1);
});
