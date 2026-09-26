import { describe, it, expect } from "vitest";
import * as apiError from "../../../src/server/http/api-error.js";

describe("apiError catalog", function () {
    it("gives every entry a stable code, a status, prose, and a next step", function () {
        const factories = [
            apiError.Errors.appNotFound,
            apiError.Errors.releaseNotFound,
            apiError.Errors.assetNotFound,
            apiError.Errors.noMacosAsset,
            apiError.Errors.routeNotFound,
            apiError.Errors.upstreamUnavailable,
            apiError.Errors.rateLimited,
            apiError.Errors.unsupportedMedia,
            apiError.Errors.badRequest,
            apiError.Errors.internal
        ];
        for (let i = 0; i < factories.length; i += 1) {
            const err = factories[i]();
            expect(err.code.length).toBeGreaterThan(0);
            expect(err.status).toBeGreaterThanOrEqual(400);
            expect(err.message.length).toBeGreaterThan(0);
            expect(err.nextStep.length).toBeGreaterThan(0);
        }
    });

    it("never blames the person in any message", function () {
        const factories = [
            apiError.Errors.appNotFound,
            apiError.Errors.releaseNotFound,
            apiError.Errors.assetNotFound,
            apiError.Errors.noMacosAsset,
            apiError.Errors.routeNotFound,
            apiError.Errors.upstreamUnavailable,
            apiError.Errors.rateLimited,
            apiError.Errors.unsupportedMedia,
            apiError.Errors.badRequest,
            apiError.Errors.internal
        ];
        const blaming = ["you selected", "you chose", "your fault", "invalid request from you"];
        for (let i = 0; i < factories.length; i += 1) {
            const err = factories[i]();
            const text = (err.message + " " + err.nextStep).toLowerCase();
            for (let j = 0; j < blaming.length; j += 1) {
                expect(text.indexOf(blaming[j])).toBe(-1);
            }
        }
    });

    it("carries no URL, filesystem path, or stack-shaped text", function () {
        const factories = [apiError.Errors.appNotFound, apiError.Errors.internal, apiError.Errors.upstreamUnavailable];
        // A route reference like "/docs" is legitimate help; what must never appear is a real
        // upstream URL, an absolute host path, an errno, or a stack frame.
        const leaks = ["://", "ENOENT", "app.exe", "    at ", "api.github.com", "127.0.0.1"];
        for (let i = 0; i < factories.length; i += 1) {
            const err = factories[i]();
            const text = err.message + " " + err.nextStep;
            for (let j = 0; j < leaks.length; j += 1) {
                expect(text.indexOf(leaks[j])).toBe(-1);
            }
        }
    });
});

describe("apiError.toClientError", function () {
    it("includes a request id so a person can be helped without exchanging details", function () {
        const body = apiError.toClientError(apiError.Errors.appNotFound(), "req-42");

        expect(body.error.code).toBe("APP_NOT_FOUND");
        expect(body.error.requestId).toBe("req-42");
        expect(body.error.nextStep.length).toBeGreaterThan(0);
    });
});

describe("apiError.toSafeApiError", function () {
    it("passes a typed ApiError through unchanged", function () {
        const original = apiError.Errors.rateLimited();
        expect(apiError.toSafeApiError(original)).toBe(original);
    });

    it("collapses an arbitrary Error to a generic 500", function () {
        const safe = apiError.toSafeApiError(new Error("ENOENT: no such file, open '/srv/secret/app.exe'"));

        expect(safe.status).toBe(500);
        expect(safe.code).toBe("INTERNAL_ERROR");
        expect(safe.message).toBe("Something went wrong on our side.");
    });

    it("collapses a thrown string to a generic 500", function () {
        const safe = apiError.toSafeApiError("plain string failure");

        expect(safe.status).toBe(500);
        expect(safe.code).toBe("INTERNAL_ERROR");
    });

    it("collapses a thrown null to a generic 500", function () {
        const safe = apiError.toSafeApiError(null);

        expect(safe.status).toBe(500);
    });
});

describe("apiError.fromStatus", function () {
    it("maps 404 to a not-found entry", function () {
        expect(apiError.fromStatus(404).code).toBe("NOT_FOUND");
    });

    it("maps 415 to an unsupported-media entry", function () {
        expect(apiError.fromStatus(415).code).toBe("UNSUPPORTED_MEDIA_TYPE");
    });

    it("maps 429 to a rate-limited entry", function () {
        expect(apiError.fromStatus(429).code).toBe("RATE_LIMITED");
    });

    it("maps other client statuses to a bad-request entry", function () {
        expect(apiError.fromStatus(400).code).toBe("BAD_REQUEST");
        expect(apiError.fromStatus(403).code).toBe("BAD_REQUEST");
        expect(apiError.fromStatus(413).code).toBe("BAD_REQUEST");
    });

    it("collapses server statuses to a generic 500", function () {
        expect(apiError.fromStatus(500).code).toBe("INTERNAL_ERROR");
        expect(apiError.fromStatus(503).code).toBe("INTERNAL_ERROR");
    });
});
