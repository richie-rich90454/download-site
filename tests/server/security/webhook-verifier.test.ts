import { describe, it, expect, vi } from "vitest";

import * as crypto from "node:crypto";

import * as webhookVerifier from "../../../src/server/security/webhook-verifier.js";

import { SilentLogger } from "../test-helpers.js";

function createRequest(body: unknown, signature?: string | string[]): Record<string, unknown> {
    const headers: Record<string, unknown> = {};

    if (signature !== undefined) {
        headers["x-hub-signature-256"] = signature;
    }

    return {
        body: body,

        headers: headers,

        url: "/webhooks/github/release"
    };
}

function createReply() {
    const statusCode = { value: 0 };

    const payload = { value: undefined as unknown };

    const reply = {
        status: function (code: number) {
            statusCode.value = code;

            return reply;
        },

        send: function (data: unknown) {
            payload.value = data;

            return reply;
        }
    };

    return { reply: reply, statusCode: statusCode, payload: payload };
}

describe("buildWebhookVerifier", function () {
    it("returns 403 when webhook secret is not configured", function () {
        const verify = webhookVerifier.buildWebhookVerifier({ secret: undefined, logger: new SilentLogger() });

        const request = createRequest({}, "sha256=anything");

        const replyResult = createReply();

        const reply = replyResult.reply;

        const statusCode = replyResult.statusCode;

        const done = vi.fn();

        verify(request as never, reply as never, done);

        expect(statusCode.value).toBe(403);

        expect(done).not.toHaveBeenCalled();
    });

    it("returns 401 when signature header is missing", function () {
        const verify = webhookVerifier.buildWebhookVerifier({ secret: "secret", logger: new SilentLogger() });

        const request = createRequest({});

        const replyResult = createReply();

        const reply = replyResult.reply;

        const statusCode = replyResult.statusCode;

        const done = vi.fn();

        verify(request as never, reply as never, done);

        expect(statusCode.value).toBe(401);

        expect(done).not.toHaveBeenCalled();
    });

    it("verifies string payload", function () {
        const secret = "webhook-secret";

        const payload = '{"action":"published"}';

        const signature = "sha256=" + crypto.createHmac("sha256", secret).update(payload).digest("hex");

        const verify = webhookVerifier.buildWebhookVerifier({ secret: secret, logger: new SilentLogger() });

        const request = createRequest(payload, signature);

        const replyResult = createReply();

        const reply = replyResult.reply;

        const statusCode = replyResult.statusCode;

        const done = vi.fn();

        verify(request as never, reply as never, done);

        expect(statusCode.value).toBe(0);

        expect(done).toHaveBeenCalled();
    });

    it("verifies request with array signature header", function () {
        const secret = "webhook-secret";

        const payload = '{"action":"published"}';

        const signature = "sha256=" + crypto.createHmac("sha256", secret).update(payload).digest("hex");

        const verify = webhookVerifier.buildWebhookVerifier({ secret: secret, logger: new SilentLogger() });

        const request = createRequest(payload, [signature, "ignored"]);

        const replyResult = createReply();

        const reply = replyResult.reply;

        const statusCode = replyResult.statusCode;

        const done = vi.fn();

        verify(request as never, reply as never, done);

        expect(statusCode.value).toBe(0);

        expect(done).toHaveBeenCalled();
    });

    it("verifies Buffer payload", function () {
        const secret = "webhook-secret";

        const payload = Buffer.from('{"action":"published"}', "utf8");

        const signature = "sha256=" + crypto.createHmac("sha256", secret).update(payload).digest("hex");

        const verify = webhookVerifier.buildWebhookVerifier({ secret: secret, logger: new SilentLogger() });

        const request = createRequest(payload, signature);

        const replyResult = createReply();

        const reply = replyResult.reply;

        const statusCode = replyResult.statusCode;

        const done = vi.fn();

        verify(request as never, reply as never, done);

        expect(statusCode.value).toBe(0);

        expect(done).toHaveBeenCalled();
    });

    it("verifies object payload by serializing", function () {
        const secret = "webhook-secret";

        const payload = { action: "published" };

        const signature = "sha256=" + crypto.createHmac("sha256", secret).update(JSON.stringify(payload)).digest("hex");

        const verify = webhookVerifier.buildWebhookVerifier({ secret: secret, logger: new SilentLogger() });

        const request = createRequest(payload, signature);

        const replyResult = createReply();

        const reply = replyResult.reply;

        const statusCode = replyResult.statusCode;

        const done = vi.fn();

        verify(request as never, reply as never, done);

        expect(statusCode.value).toBe(0);

        expect(done).toHaveBeenCalled();
    });

    it("rejects invalid signature", function () {
        const secret = "webhook-secret";

        const payload = '{"action":"published"}';

        const verify = webhookVerifier.buildWebhookVerifier({ secret: secret, logger: new SilentLogger() });

        const request = createRequest(payload, "sha256=invalid");

        const replyResult = createReply();

        const reply = replyResult.reply;

        const statusCode = replyResult.statusCode;

        const done = vi.fn();

        verify(request as never, reply as never, done);

        expect(statusCode.value).toBe(401);

        expect(done).not.toHaveBeenCalled();
    });

    it("rejects signature with different length", function () {
        const secret = "webhook-secret";

        const payload = '{"action":"published"}';

        const verify = webhookVerifier.buildWebhookVerifier({ secret: secret, logger: new SilentLogger() });

        const request = createRequest(payload, "sha256=short");

        const replyResult = createReply();

        const reply = replyResult.reply;

        const statusCode = replyResult.statusCode;

        const done = vi.fn();

        verify(request as never, reply as never, done);

        expect(statusCode.value).toBe(401);

        expect(done).not.toHaveBeenCalled();
    });
    it("accepts a Buffer body", function () {
        const secret = "webhook-secret";
        const payload = '{"action":"published"}';
        const signature = "sha256=" + crypto.createHmac("sha256", secret).update(payload).digest("hex");
        const verify = webhookVerifier.buildWebhookVerifier({ secret: secret, logger: new SilentLogger() });
        const request = createRequest(Buffer.from(payload, "utf8"), signature);
        const replyResult = createReply();
        const done = vi.fn();

        verify(request as never, replyResult.reply as never, done);

        expect(done).toHaveBeenCalled();
    });

    it("rejects a replayed delivery id", function () {
        const secret = "webhook-secret";
        const payload = '{"action":"published"}';
        const signature = "sha256=" + crypto.createHmac("sha256", secret).update(payload).digest("hex");
        const verify = webhookVerifier.buildWebhookVerifier({ secret: secret, logger: new SilentLogger() });

        const first = createRequest(payload, signature);
        first.headers["x-github-delivery"] = "delivery-1";
        verify(first as never, createReply().reply as never, vi.fn());

        const second = createRequest(payload, signature);
        second.headers["x-github-delivery"] = "delivery-1";
        const replyResult = createReply();
        const done = vi.fn();
        verify(second as never, replyResult.reply as never, done);

        expect(replyResult.statusCode.value).toBe(401);
        expect(done).not.toHaveBeenCalled();
    });

    it("accepts a repeated delivery id after the window elapses", function () {
        const guard = new webhookVerifier.ReplayGuard(1000);
        expect(guard.accept("d1", 0)).toBe(true);
        expect(guard.accept("d1", 0)).toBe(false);
        expect(guard.accept("d1", 5000)).toBe(true);
    });

    it("bounds the number of remembered deliveries", function () {
        const guard = new webhookVerifier.ReplayGuard(60000);
        for (let i = 0; i < 5000; i += 1) {
            guard.accept("delivery-" + String(i), i);
        }
        // The oldest entries are dropped, so the map cannot grow without bound.
        expect(guard.accept("delivery-0", 5000)).toBe(true);
    });

    it("accepts an array-valued delivery header", function () {
        const secret = "webhook-secret";
        const payload = '{"action":"published"}';
        const signature = "sha256=" + crypto.createHmac("sha256", secret).update(payload).digest("hex");
        const verify = webhookVerifier.buildWebhookVerifier({
            secret: secret,
            logger: new SilentLogger(),
            replayWindowMs: 60000
        });
        const request = createRequest(payload, signature);
        request.headers["x-github-delivery"] = ["delivery-array", "delivery-other"];
        const done = vi.fn();

        verify(request as never, createReply().reply as never, done);

        expect(done).toHaveBeenCalled();
    });

    it("treats an empty secret as disabled", function () {
        // An empty value is how the surface is switched off, so it must not be treated as a
        // secret that merely happens to match an empty signature.
        const verify = webhookVerifier.buildWebhookVerifier({ secret: "", logger: new SilentLogger() });
        const request = createRequest(
            '{"action":"published"}',
            "sha256=" + crypto.createHash("sha256").update('{"action":"published"}').digest("hex")
        );
        const replyResult = createReply();
        const done = vi.fn();

        verify(request as never, replyResult.reply as never, done);

        expect(replyResult.statusCode.value).toBe(403);
        expect(done).not.toHaveBeenCalled();
    });

    it("skips replay protection when the window is disabled", function () {
        const secret = "webhook-secret";
        const payload = '{"action":"published"}';
        const signature = "sha256=" + crypto.createHmac("sha256", secret).update(payload).digest("hex");
        const verify = webhookVerifier.buildWebhookVerifier({
            secret: secret,
            logger: new SilentLogger(),
            replayWindowMs: 0
        });

        for (let i = 0; i < 2; i += 1) {
            const request = createRequest(payload, signature);
            request.headers["x-github-delivery"] = "delivery-same";
            const done = vi.fn();
            verify(request as never, createReply().reply as never, done);
            expect(done).toHaveBeenCalled();
        }
    });
});
