import * as config from "./config/config.js";
import * as container from "./container.js";
import * as appFactory from "./app.js";
import { startLifecycle } from "./lifecycle.js";

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

    startLifecycle(services, app);
}

main().catch(function (err) {
    console.error("Failed to start server:", err);
    process.exit(1);
});
