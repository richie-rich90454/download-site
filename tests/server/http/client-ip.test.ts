import { describe, it, expect } from "vitest";
import * as clientIp from "../../../src/server/http/client-ip.js";

const CF_IPV4 = "104.16.0.1";
const CF_IPV6 = "2606:4700::1";

describe("isCloudflareAddress", function () {
    it("accepts addresses inside the published Cloudflare ranges", function () {
        expect(clientIp.isCloudflareAddress(CF_IPV4)).toBe(true);
        expect(clientIp.isCloudflareAddress("172.64.0.1")).toBe(true);
        expect(clientIp.isCloudflareAddress("198.41.128.1")).toBe(true);
        expect(clientIp.isCloudflareAddress(CF_IPV6)).toBe(true);
    });

    it("rejects addresses outside them", function () {
        expect(clientIp.isCloudflareAddress("203.0.113.5")).toBe(false);
        expect(clientIp.isCloudflareAddress("127.0.0.1")).toBe(false);
        expect(clientIp.isCloudflareAddress("10.0.0.1")).toBe(false);
        expect(clientIp.isCloudflareAddress("2606:4701::1")).toBe(false);
    });

    it("rejects an absent or malformed address", function () {
        expect(clientIp.isCloudflareAddress(undefined)).toBe(false);
        expect(clientIp.isCloudflareAddress("")).toBe(false);
        expect(clientIp.isCloudflareAddress("not-an-address")).toBe(false);
    });

    it("treats an IPv4-mapped IPv6 peer as the IPv4 address it is", function () {
        // Node reports IPv4 peers as ::ffff:a.b.c.d when the socket is dual stack.
        expect(clientIp.isCloudflareAddress("::ffff:" + CF_IPV4)).toBe(true);
    });
});

describe("resolveClientId", function () {
    it("trusts cf-connecting-ip when the peer is Cloudflare", function () {
        const result = clientIp.resolveClientId(CF_IPV4, { "cf-connecting-ip": "203.0.113.9" });

        expect(result.clientId).toBe("203.0.113.9");
        expect(result.viaCloudflare).toBe(true);
    });

    it("ignores cf-connecting-ip from a peer that is not Cloudflare", function () {
        // This is the forged-header case: anyone can set the header, so it is only believed when
        // the connection genuinely came from the edge.
        const result = clientIp.resolveClientId("203.0.113.5", { "cf-connecting-ip": "1.2.3.4" });

        expect(result.clientId).toBe("203.0.113.5");
        expect(result.viaCloudflare).toBe(false);
        expect(result.reason).toBe("peer is not a Cloudflare address");
    });

    it("ignores X-Forwarded-For entirely", function () {
        const result = clientIp.resolveClientId("203.0.113.5", { "x-forwarded-for": "1.2.3.4" });

        expect(result.clientId).toBe("203.0.113.5");
    });

    it("falls back to the peer when Cloudflare sends no header", function () {
        const result = clientIp.resolveClientId(CF_IPV4, {});

        expect(result.clientId).toBe(CF_IPV4);
        expect(result.viaCloudflare).toBe(true);
        expect(result.reason).toBe("no cf-connecting-ip header");
    });

    it("falls back to the peer when the header is not an address", function () {
        const result = clientIp.resolveClientId(CF_IPV4, { "cf-connecting-ip": "not-an-ip" });

        expect(result.clientId).toBe(CF_IPV4);
        expect(result.reason).toBe("cf-connecting-ip is not an address");
    });

    it("takes the first value of an array-valued header", function () {
        const result = clientIp.resolveClientId(CF_IPV4, { "cf-connecting-ip": ["203.0.113.9", "1.2.3.4"] });

        expect(result.clientId).toBe("203.0.113.9");
    });

    it("handles an absent peer address", function () {
        const result = clientIp.resolveClientId(undefined, { "cf-connecting-ip": "203.0.113.9" });

        expect(result.clientId).toBe("unknown");
        expect(result.reason).toBe("no peer address");
    });

    it("handles an empty peer address", function () {
        const result = clientIp.resolveClientId("", {});

        expect(result.clientId).toBe("unknown");
    });

    it("normalises an IPv4-mapped forwarded address", function () {
        const result = clientIp.resolveClientId(CF_IPV4, { "cf-connecting-ip": "::ffff:203.0.113.9" });

        expect(result.clientId).toBe("203.0.113.9");
    });

    it("resolves an IPv6 client through the edge", function () {
        const result = clientIp.resolveClientId(CF_IPV6, { "cf-connecting-ip": "2606:4701::abcd" });

        expect(result.clientId).toBe("2606:4701::abcd");
        expect(result.viaCloudflare).toBe(true);
    });
});

describe("anonymizeAddress", function () {
    it("produces a stable token for the same address and salt", function () {
        const first = clientIp.anonymizeAddress("203.0.113.9", "salt-a");
        const second = clientIp.anonymizeAddress("203.0.113.9", "salt-a");

        expect(first).toBe(second);
        expect(first).not.toBe("203.0.113.9");
    });

    it("produces a different token for a different address", function () {
        expect(clientIp.anonymizeAddress("203.0.113.9", "salt-a")).not.toBe(
            clientIp.anonymizeAddress("203.0.113.10", "salt-a")
        );
    });

    it("produces a different token for a different salt, so restarts are not correlatable", function () {
        expect(clientIp.anonymizeAddress("203.0.113.9", "salt-a")).not.toBe(
            clientIp.anonymizeAddress("203.0.113.9", "salt-b")
        );
    });

    it("always returns a fixed-width hex token", function () {
        const token = clientIp.anonymizeAddress("203.0.113.9", "salt-a");
        expect(token.length).toBe(8);
        expect(/^[0-9a-f]+$/.test(token)).toBe(true);
    });
});
