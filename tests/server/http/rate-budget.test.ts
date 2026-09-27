import { describe, it, expect } from "vitest";
import { GcraLimiter, defaultBudgets } from "../../../src/server/http/rate-budget.js";

function limiter(limit: number, burst: number): GcraLimiter {
    return new GcraLimiter({ limit: limit, periodMs: 1000, burst: burst });
}

describe("GcraLimiter", function () {
    it("admits an initial burst then enforces the sustained rate", function () {
        const subject = limiter(10, 3);
        const now = 100000;

        // 10 per second is one request every 100ms; a burst of 3 is 300ms of slack.
        expect(subject.check("a", now).allowed).toBe(true);
        expect(subject.check("a", now).allowed).toBe(true);
        expect(subject.check("a", now).allowed).toBe(true);
        const refused = subject.check("a", now);
        expect(refused.allowed).toBe(false);
        expect(refused.retryAfterMs).toBeGreaterThan(0);
    });

    it("admits again once the burst allowance recovers", function () {
        const subject = limiter(10, 2);
        const now = 0;
        subject.check("a", now);
        subject.check("a", now);
        expect(subject.check("a", now).allowed).toBe(false);

        expect(subject.check("a", 500).allowed).toBe(true);
    });

    it("keeps clients independent", function () {
        const subject = limiter(1, 1);
        expect(subject.check("client-a", 0).allowed).toBe(true);
        expect(subject.check("client-a", 0).allowed).toBe(false);
        // One noisy client must not consume another's allowance.
        expect(subject.check("client-b", 0).allowed).toBe(true);
    });

    it("reports a retry hint in milliseconds", function () {
        const subject = limiter(1, 1);
        subject.check("a", 0);
        const decision = subject.check("a", 0);
        expect(decision.allowed).toBe(false);
        expect(decision.retryAfterMs).toBe(1000);
    });

    it("reports remaining burst as it is consumed", function () {
        const subject = limiter(10, 3);
        expect(subject.check("a", 0).remaining).toBe(2);
        expect(subject.check("a", 0).remaining).toBe(1);
        expect(subject.check("a", 0).remaining).toBe(0);
    });

    it("does not burst at a window boundary the way a fixed window would", function () {
        // 10 per second, burst 1. A fixed window releases all 10 again the instant the window
        // rolls over; GCRA keeps the debt, so a second aligned window adds nothing.
        const subject = limiter(10, 1);
        let admitted = 0;
        for (let t = 0; t < 1000; t += 1) {
            if (subject.check("a", t).allowed) {
                admitted = admitted + 1;
            }
        }

        // At most 10 in the first second, and not 20 from two back-to-back window releases.
        expect(admitted).toBeLessThanOrEqual(10);
        expect(admitted).toBeGreaterThanOrEqual(9);
    });

    it("spaces admissions by the emission interval rather than releasing them together", function () {
        const subject = limiter(10, 1);
        expect(subject.check("a", 0).allowed).toBe(true);
        expect(subject.check("a", 0).allowed).toBe(false);
        expect(subject.check("a", 99).allowed).toBe(false);
        expect(subject.check("a", 100).allowed).toBe(true);
        expect(subject.check("a", 199).allowed).toBe(false);
        expect(subject.check("a", 200).allowed).toBe(true);
    });

    it("forgets a key that has fully recovered", function () {
        const subject = limiter(1, 1);
        subject.check("a", 0);
        expect(subject.size()).toBe(1);

        subject.pruneNow(5000);
        expect(subject.size()).toBe(0);
    });

    it("caps an idle key's burst so a long-idle client does not hoard allowance", function () {
        const subject = limiter(10, 3);
        // Three requests spaced by the emission interval, then a long idle period.
        subject.check("a", 0);
        subject.check("a", 100);
        subject.check("a", 200);
        subject.check("a", 500000);

        // The debt has fully recovered, so the client is back to exactly its burst allowance of
        // three: the setup call above took the first, two more fit, and the fourth is refused.
        expect(subject.check("a", 500000).allowed).toBe(true);
        expect(subject.check("a", 500000).allowed).toBe(true);
        expect(subject.check("a", 500000).allowed).toBe(false);
    });

    it("reports zero remaining once the burst is spent", function () {
        const subject = limiter(10, 2);
        subject.check("a", 0);
        subject.check("a", 0);

        expect(subject.check("a", 0).remaining).toBe(0);
    });

    it("bounds the number of tracked keys under a same-instant flood", function () {
        // Every request lands in the same millisecond, so nothing has recovered and pruning
        // cannot free anything. The hard capacity limit is the only thing bounding memory here,
        // which is exactly the address-spoofing flood it exists to stop.
        const subject = new GcraLimiter({ limit: 1, periodMs: 1000, burst: 1 });
        for (let i = 0; i < 21000; i = i + 1) {
            subject.check("client-" + String(i), 0);
        }
        expect(subject.size()).toBeLessThanOrEqual(20000);
    });

    it("prunes recovered buckets so memory stays bounded under sustained load", function () {
        const subject = new GcraLimiter({ limit: 100, periodMs: 60000, burst: 10 });
        // Requests spread over a long period: earlier clients' allowances fully recover, so the
        // map must not grow in step with the request count.
        for (let i = 0; i < 5000; i = i + 1) {
            subject.check("client-" + String(i), i * 1000);
        }
        expect(subject.size()).toBeLessThan(2000);

        // Far enough in the future that every allowance has recovered.
        subject.check("late-arrival", 100000000);
        expect(subject.size()).toBe(1);
    });

    it("treats a zero limit as a rate of one", function () {
        const subject = new GcraLimiter({ limit: 0, periodMs: 1000, burst: 1 });
        expect(subject.check("a", 0).allowed).toBe(true);
        expect(subject.check("a", 0).allowed).toBe(false);
    });
});

describe("defaultBudgets", function () {
    it("gives downloads a much higher ceiling than admin routes", function () {
        const budgets = defaultBudgets();

        // A tight per-address cap is a classist rule when a whole campus shares one NAT address,
        // so downloads get headroom and only admin stays tight.
        expect(budgets.download.limit).toBeGreaterThan(budgets.api.limit);
        expect(budgets.api.limit).toBeGreaterThan(budgets.admin.limit);
        expect(budgets.download.burst).toBeGreaterThan(budgets.admin.burst);
    });
});
