import * as config from "./config/config.js";
import * as container from "./container.js";
import * as appFactory from "./app.js";

async function main(): Promise<void> {
    const cfg = config.loadConfig();
    const services = container.registerServices(cfg);
    const app = await appFactory.buildApp(services);

    await services.release.warmCache();

    const refreshInterval = setInterval(function () {
        services.release.warmCache().catch(function (err) {
            const message = err instanceof Error ? err.message : String(err);
            services.logger.error("Periodic cache refresh failed", { error: message });
        });
    }, 300000);

    const shutdown = async function (signal: string): Promise<void> {
        services.logger.info("Shutting down server", { signal: signal });
        clearInterval(refreshInterval);
        await app.close();
        services.metadataCache.close();
        services.assetCache.close();
        services.logger.info("Server shutdown complete");
        process.exit(0);
    };

    process.on("SIGTERM", function () {
        shutdown("SIGTERM").catch(function (err) {
            const message = err instanceof Error ? err.message : String(err);
            services.logger.error("Shutdown failed", { error: message });
            process.exit(1);
        });
    });

    process.on("SIGINT", function () {
        shutdown("SIGINT").catch(function (err) {
            const message = err instanceof Error ? err.message : String(err);
            services.logger.error("Shutdown failed", { error: message });
            process.exit(1);
        });
    });

    await app.listen({ port: cfg.port, host: "0.0.0.0" });
    services.logger.info("Server listening", { port: cfg.port });
}

main().catch(function (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("Failed to start server:", message);
    process.exit(1);
});
