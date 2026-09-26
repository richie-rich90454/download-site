import * as crypto from "node:crypto";

/**
 * Constant-time string comparison for secrets.
 *
 * `crypto.timingSafeEqual` throws when the two buffers differ in length, so the usual guard
 * compares lengths first - which is itself an early return and leaks the length of the secret.
 * Hashing both sides to a fixed 32-byte digest first removes that channel entirely: the
 * comparison is then over equal-length buffers no matter what the inputs look like, so the
 * duration does not depend on either the length or how many leading characters match.
 *
 * `sha256:` and `sha256=` style prefixes are handled by the caller, not here.
 */
export function safeSecretEqual(provided: string, expected: string): boolean {
    const providedDigest = crypto.createHash("sha256").update(provided, "utf8").digest();
    const expectedDigest = crypto.createHash("sha256").update(expected, "utf8").digest();
    return crypto.timingSafeEqual(providedDigest, expectedDigest);
}

/**
 * Enforces a minimum length on a secret that has been supplied.
 *
 * Returns an error message rather than throwing so the caller can surface it as a startup
 * diagnostic. An absent secret is reported separately: leaving ADMIN_API_KEY unset is a valid
 * way to disable the admin surface, whereas setting it to something guessable is not.
 */
export function describeWeakSecret(name: string, value: string | undefined, minimumLength: number): string | undefined {
    if (value === undefined || value.length === 0) {
        return undefined;
    }
    if (value.length < minimumLength) {
        return name + " is set but shorter than " + String(minimumLength) + " characters; use a longer random value";
    }
    return undefined;
}
