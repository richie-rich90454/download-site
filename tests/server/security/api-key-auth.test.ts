import { describe, it, expect, vi } from "vitest";
import * as apiKeyAuth from "../../../src/server/security/api-key-auth.js";
import { SilentLogger } from "../test-helpers.js";

function createRequest(headerValue: unknown): Record<string, unknown> {
    const headers: Record<string, unknown> = {};
    if (headerValue !== undefined) {
        headers["x-admin-api-key"] = headerValue;
    }
    return {
        headers: headers,
        url: "/admin/cache/purge",
        method: "POST"
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

describe("buildApiKeyAuth", function () {
    it("authorizes request when x-admin-api-key header is an array", function () {
        const auth = apiKeyAuth.buildApiKeyAuth({ apiKey: "secret-key", logger: new SilentLogger() });
        const request = createRequest(["secret-key", "ignored"]);
        const replyResult = createReply();
        const reply = replyResult.reply;
        const statusCode = replyResult.statusCode;
        const done = vi.fn();

        auth(request as never, reply as never, done);

        expect(statusCode.value).toBe(0);
        expect(done).toHaveBeenCalled();
    });

    it("rejects request when x-admin-api-key header array contains wrong key", function () {
        const auth = apiKeyAuth.buildApiKeyAuth({ apiKey: "secret-key", logger: new SilentLogger() });
        const request = createRequest(["wrong-key", "ignored"]);
        const replyResult = createReply();
        const reply = replyResult.reply;
        const statusCode = replyResult.statusCode;
        const done = vi.fn();

        auth(request as never, reply as never, done);

        expect(statusCode.value).toBe(401);
        expect(done).not.toHaveBeenCalled();
    });
});
