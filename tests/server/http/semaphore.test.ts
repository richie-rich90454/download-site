/**
 * @vitest-environment node
 */
import { describe, it, expect } from "vitest";
import { Semaphore } from "../../../src/server/http/semaphore.js";

function deferred(): { promise: Promise<void>; resolve: () => void } {
    let resolve = function (): void {
        // replaced below
    };
    const promise = new Promise<void>(function (res) {
        resolve = res;
    });
    return { promise: promise, resolve: resolve };
}

describe("Semaphore", function () {
    it("refuses a limit that cannot admit anyone", function () {
        expect(function () {
            return new Semaphore(0);
        }).toThrow("Semaphore limit must be a positive integer");
        expect(function () {
            return new Semaphore(1.5);
        }).toThrow("Semaphore limit must be a positive integer");
    });

    it("admits up to the limit without queueing", async function () {
        const semaphore = new Semaphore(2);
        let running = 0;
        let peak = 0;
        const work = async function (): Promise<void> {
            running = running + 1;
            peak = Math.max(peak, running);
            await Promise.resolve();
            running = running - 1;
        };
        await Promise.all([semaphore.run(work), semaphore.run(work)]);
        expect(peak).toBe(2);
        expect(semaphore.queued).toBe(0);
    });

    it("queues past the limit and drains in order", async function () {
        const semaphore = new Semaphore(1);
        const started: number[] = [];
        const gate = deferred();
        const first = semaphore.run(async function () {
            started.push(1);
            await gate.promise;
        });
        // The second caller must wait, not run alongside the first.
        const second = semaphore.run(async function () {
            started.push(2);
        });
        expect(semaphore.queued).toBe(1);

        gate.resolve();
        await Promise.all([first, second]);
        expect(started).toEqual([1, 2]);
        expect(semaphore.queued).toBe(0);
    });

    it("never exceeds the limit however many callers arrive", async function () {
        const semaphore = new Semaphore(3);
        let running = 0;
        let peak = 0;
        const work = async function (): Promise<void> {
            running = running + 1;
            peak = Math.max(peak, running);
            await Promise.resolve();
            await Promise.resolve();
            running = running - 1;
        };
        const calls: Array<Promise<void>> = [];
        for (let i = 0; i < 20; i = i + 1) {
            calls.push(semaphore.run(work));
        }
        await Promise.all(calls);
        // The whole point of the bound: a burst of downloads becomes a queue, not a pile-up.
        expect(peak).toBe(3);
    });

    it("releases the slot when the work throws", async function () {
        const semaphore = new Semaphore(1);
        await expect(
            semaphore.run(async function () {
                throw new Error("download failed");
            })
        ).rejects.toThrow("download failed");
        // A leaked slot would deadlock every later download for the life of the process.
        expect(semaphore.queued).toBe(0);
        await expect(
            semaphore.run(async function () {
                return "ok";
            })
        ).resolves.toBe("ok");
    });

    it("hands the slot straight to the next waiter rather than the pool", async function () {
        const semaphore = new Semaphore(1);
        const order: string[] = [];
        const gate = deferred();
        const first = semaphore.run(async function () {
            order.push("first-start");
            await gate.promise;
            order.push("first-end");
        });
        const second = semaphore.run(async function () {
            order.push("second-start");
        });
        gate.resolve();
        await Promise.all([first, second]);
        // If release() put the slot back in the pool, a later caller could overtake a queued one.
        expect(order).toEqual(["first-start", "first-end", "second-start"]);
    });
});
