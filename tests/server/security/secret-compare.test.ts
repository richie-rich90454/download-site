import { describe, it, expect } from "vitest";
import * as secret from "../../../src/server/security/secret-compare.js";

describe("safeSecretEqual", function () {
    it("accepts an exact match", function () {
        expect(secret.safeSecretEqual("s3cret-value", "s3cret-value")).toBe(true);
    });

    it("rejects a mismatch", function () {
        expect(secret.safeSecretEqual("s3cret-value", "s3cret-valuf")).toBe(false);
    });

    it("rejects empty input on either side", function () {
        expect(secret.safeSecretEqual("", "")).toBe(true);
        expect(secret.safeSecretEqual("", "value")).toBe(false);
        expect(secret.safeSecretEqual("value", "")).toBe(false);
    });

    it("rejects a mismatch that shares a long prefix", function () {
        const expected = "a".repeat(512) + "tail";
        const provided = "a".repeat(512) + "fail";
        expect(secret.safeSecretEqual(provided, expected)).toBe(false);
    });

    it("does not depend on input length, so a length oracle is not available", function () {
        // A raw byte comparison must branch on length, which leaks the secret's size. Hashing
        // both sides first means the compared buffers are always 32 bytes.
        const shortSecret = "k".repeat(8);
        const longSecret = "k".repeat(4096);
        expect(secret.safeSecretEqual(shortSecret, shortSecret)).toBe(true);
        expect(secret.safeSecretEqual(longSecret, longSecret)).toBe(true);
        expect(secret.safeSecretEqual(shortSecret, longSecret)).toBe(false);
        expect(secret.safeSecretEqual(longSecret, shortSecret)).toBe(false);
    });

    it("handles non-ascii input consistently", function () {
        expect(secret.safeSecretEqual("pässwörd-ü", "pässwörd-ü")).toBe(true);
        expect(secret.safeSecretEqual("pässwörd-ü", "passwörd-u")).toBe(false);
    });
});

describe("describeWeakSecret", function () {
    it("returns undefined when the secret is absent", function () {
        expect(secret.describeWeakSecret("ADMIN_API_KEY", undefined, 32)).toBeUndefined();
    });

    it("returns undefined when the secret is empty, which means the surface is disabled", function () {
        expect(secret.describeWeakSecret("ADMIN_API_KEY", "", 32)).toBeUndefined();
    });

    it("reports a secret that is present but too short", function () {
        const problem = secret.describeWeakSecret("ADMIN_API_KEY", "tooshort", 32);
        expect(problem).toBe("ADMIN_API_KEY is set but shorter than 32 characters; use a longer random value");
    });

    it("accepts a secret at exactly the minimum length", function () {
        expect(secret.describeWeakSecret("ADMIN_API_KEY", "x".repeat(32), 32)).toBeUndefined();
    });

    it("rejects a secret one character below the minimum", function () {
        expect(secret.describeWeakSecret("WEBHOOK_SECRET", "x".repeat(31), 32)).not.toBeUndefined();
    });
});
