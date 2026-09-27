import Fastify from "fastify";
import type { FastifyInstance, FastifyError, FastifyRequest, FastifyReply } from "fastify";
import * as fs from "node:fs";
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
import * as apiError from "./http/api-error.js";

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

    // Handlers are installed before any route is registered. Fastify binds a route to the error
    // handler in scope at the moment the route is added, so a handler set afterwards does not
    // reliably apply - and adding an encapsulated plugin later in the sequence can change that
    // silently, which is exactly what happened when the webhook routes gained a scoped parser.
    // Setting them first removes the ordering dependency rather than working around it.
    app.setErrorHandler(function (error: FastifyError, request: FastifyRequest, reply: FastifyReply) {
        const requestId = String(request.id);
        const status = error.statusCode !== undefined ? error.statusCode : 500;
        // A typed ApiError keeps its own status. Anything else is mapped by status, so Fastify's
        // own 4xx stay 4xx and every 5xx collapses to a generic message.
        const reported =
            error instanceof apiError.ApiError
                ? error
                : status >= 400 && status < 500
                  ? apiError.fromStatus(status)
                  : apiError.Errors.internal();
        services.logger.error("Request error", {
            requestId: requestId,
            method: request.method,
            url: request.url,
            statusCode: reported.status,
            code: reported.code,
            // The full message and any validation detail stay server-side. Echoing them is what
            // leaked absolute paths and private repository names to clients.
            message: error.message,
            validation: error.validation
        });
        reply.status(reported.status).send(apiError.toClientError(reported, requestId));
    });

    app.setNotFoundHandler(function (request: FastifyRequest, reply: FastifyReply) {
        const accept = request.headers.accept;
        const wantsHtml = accept !== undefined && accept.indexOf("text/html") >= 0;
        if (wantsHtml || (request.url.indexOf("/api/") !== 0 && request.url.indexOf("/download/") !== 0)) {
            const indexPath = staticFiles.resolveIndexPath();
            if (indexPath !== undefined) {
                reply.type("text/html").send(fs.createReadStream(indexPath));
                return;
            }
        }
        const notFound = apiError.Errors.routeNotFound();
        reply.status(notFound.status).send(apiError.toClientError(notFound, String(request.id)));
    });

    await helmet.registerHelmet(app);
    await cors.registerCors(app, services.config);
    await rateLimit.registerRateLimit(app, services.config);
    await requestLogging.registerRequestLogging(app, services.logger, services.metrics);
    await swagger.registerSwagger(app, services.config, services.logger);
    await staticFiles.registerStatic(app);

    await healthRoutes.registerHealthRoutes(app);
    await appRoutes.registerAppRoutes(app);
    await releaseRoutes.registerReleaseRoutes(app);
    await updateRoutes.registerUpdateRoutes(app);
    await downloadRoutes.registerDownloadRoutes(app);
    await adminRoutes.registerAdminRoutes(app);
    await webhookRoutes.registerWebhookRoutes(app);
    await metricsRoute.registerMetricsRoute(app);

    return app;
}
