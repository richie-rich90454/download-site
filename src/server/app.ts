import Fastify from "fastify";
import type { FastifyInstance, FastifyError, FastifyRequest, FastifyReply } from "fastify";
import * as fs from "node:fs";
import * as path from "node:path";
import type { Services } from "./container.js";
import * as helmet from "./plugins/helmet.js";
import * as cors from "./plugins/cors.js";
import * as rateLimit from "./plugins/rate-limit.js";
import * as requestLogging from "./plugins/request-logging.js";
import * as swagger from "./plugins/swagger.js";
import * as staticFiles from "./plugins/static.js";
import * as healthRoutes from "./routes/health-routes.js";
import * as appRoutes from "./routes/app-routes.js";
import * as releaseRoutes from "./routes/release-routes.js";
import * as updateRoutes from "./routes/update-routes.js";
import * as downloadRoutes from "./routes/download-routes.js";
import * as adminRoutes from "./routes/admin-routes.js";
import * as webhookRoutes from "./routes/webhook-routes.js";
import * as metricsRoute from "./routes/metrics-route.js";

declare module "fastify" {
    interface FastifyInstance {
        services: Services;
    }
}

export async function buildApp(services: Services): Promise<FastifyInstance> {
    const app = Fastify({
        logger: false,
        requestTimeout: 300000,
        bodyLimit: 1048576
    });

    app.decorate("services", services);

    await helmet.registerHelmet(app);
    await cors.registerCors(app, services.config);
    await rateLimit.registerRateLimit(app, services.config);
    await requestLogging.registerRequestLogging(app, services.logger);
    await swagger.registerSwagger(app);
    await staticFiles.registerStatic(app);

    await healthRoutes.registerHealthRoutes(app);
    await appRoutes.registerAppRoutes(app);
    await releaseRoutes.registerReleaseRoutes(app);
    await updateRoutes.registerUpdateRoutes(app);
    await downloadRoutes.registerDownloadRoutes(app);
    await adminRoutes.registerAdminRoutes(app);
    await webhookRoutes.registerWebhookRoutes(app);
    await metricsRoute.registerMetricsRoute(app);

    app.setErrorHandler(function (error: FastifyError, request: FastifyRequest, reply: FastifyReply) {
        services.logger.error("Request error", {
            requestId: request.id,
            method: request.method,
            url: request.url,
            statusCode: error.statusCode,
            code: error.code,
            message: error.message
        });
        const statusCode = error.statusCode !== undefined ? error.statusCode : 500;
        const code = error.code !== undefined ? error.code : "INTERNAL_SERVER_ERROR";
        const errorPayload: Record<string, unknown> = {
            code: code,
            message: error.message
        };
        if (error.validation !== undefined && error.validation.length > 0) {
            errorPayload.details = error.validation;
        }
        reply.status(statusCode).send({ error: errorPayload });
    });

    app.setNotFoundHandler(function (request: FastifyRequest, reply: FastifyReply) {
        const accept = request.headers.accept;
        const wantsHtml = accept !== undefined && accept.indexOf("text/html") >= 0;
        if (wantsHtml || (request.url.indexOf("/api/") !== 0 && request.url.indexOf("/download/") !== 0)) {
            const publicDir = staticFiles.getPublicDir();
            const indexPath = path.resolve(publicDir, "index.html");
            if (fs.existsSync(indexPath)) {
                reply.type("text/html").send(fs.createReadStream(indexPath));
                return;
            }
        }
        reply.status(404).send({
            error: {
                code: "NOT_FOUND",
                message: "Route not found"
            }
        });
    });

    return app;
}
