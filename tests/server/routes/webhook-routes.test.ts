import { describe, it, expect } from "vitest";
import * as webhookRoutes from "../../../src/server/routes/webhook-routes.js";
import { RecordingLogger } from "../test-helpers.js";

function parse(body: unknown): { result: ReturnType<typeof webhookRoutes.parseWebhookBody>; logger: RecordingLogger } {
    const logger = new RecordingLogger();
    return { result: webhookRoutes.parseWebhookBody(body, logger), logger: logger };
}

describe("parseWebhookBody", function () {
    it("parses a raw string body", function () {
        const outcome = parse('{"action":"published","repository":{"full_name":"owner/repo"}}');
        const body = outcome.result;

        expect(body !== undefined).toBe(true);
        expect(body !== undefined ? body.action : undefined).toBe("published");
        expect(body !== undefined && body.repository !== undefined ? body.repository.full_name : undefined).toBe(
            "owner/repo"
        );
    });

    it("parses a Buffer body", function () {
        const outcome = parse(Buffer.from('{"action":"released"}', "utf8"));

        expect(outcome.result !== undefined ? outcome.result.action : undefined).toBe("released");
    });

    it("returns undefined for a body that is not raw text", function () {
        const outcome = parse({ action: "published" });

        // A pre-parsed object means the signature was not computed over the bytes we received.
        expect(outcome.result).toBeUndefined();
        expect(outcome.logger.messages("warn")).toContain(
            "Webhook body was not raw text; the signature cannot be verified"
        );
    });

    it("returns undefined for a body that is not valid JSON", function () {
        const outcome = parse("{not json");

        expect(outcome.result).toBeUndefined();
        expect(outcome.logger.messages("warn")).toContain("Webhook body was not valid JSON");
    });

    it("returns undefined for a JSON null", function () {
        expect(parse("null").result).toBeUndefined();
    });

    it("returns undefined for a JSON scalar", function () {
        expect(parse("42").result).toBeUndefined();
    });

    it("returns undefined for a JSON array, which is not a webhook object", function () {
        expect(parse("[1,2,3]").result).toBeUndefined();
    });
});
