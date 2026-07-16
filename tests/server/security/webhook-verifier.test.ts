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
});
