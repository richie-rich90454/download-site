/**
 * @vitest-environment node
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import type { FastifyInstance } from "fastify";
import * as lifecycle from "../../src/server/lifecycle.js";
import type { Services } from "../../src/server/container.js";
import { SilentLogger } from "./test-helpers.js";

interface Recorder {
    closed: boolean;
    released: string[];
    metadataClosed: number;
    assetClosed: number;
}

function fakeApp(recorder: Recorder, closeDelayMs?: number): FastifyInstance {
    return {
        close: function (): Promise<void> {
            if (closeDelayMs === undefined) {
                recorder.closed = true;
                return Promise.resolve();
            }
            return new Promise<void>(function (resolve) {
                setTimeout(function () {
                    recorder.closed = true;
                    resolve();
                }, closeDelayMs);
            });
        }
    } as unknown as FastifyInstance;
}

function fakeServices(recorder: Recorder, warm?: () => Promise<void>): Services {
    return {
        logger: new SilentLogger(),
        release: {
            warmCache:
                warm !== undefined
                    ? warm
                    : function () {
                          return Promise.resolve();
                      }
        },
        metadataCache: {
            close: function () {
                recorder.metadataClosed = recorder.metadataClosed + 1;
            }
        },
        assetCache: {
            close: function () {
                recorder.assetClosed = recorder.assetClosed + 1;
            }
        }
    } as unknown as Services;
}

function newRecorder(): Recorder {
    return { closed: false, released: [], metadataClosed: 0, assetClosed: 0 };
}

/** An interval that never fires, so a test controls when it stops. */
function idleInterval(): ReturnType<typeof setInterval> {
    return setInterval(function () {
        // intentionally empty
    }, 60000);
}

function noopExit(): void {
    // never exits: a test must not end the process
}

function wait(ms: number): Promise<void> {
    return new Promise(function (resolve) {
        setTimeout(resolve, ms);
    });
}

afterEach(function () {
    vi.restoreAllMocks();
});

describe("lifecycle drain", function () {
    it("closes the app before the caches so in-flight reads still work", async function () {
        const order: string[] = [];
        const app = {
            close: function (): Promise<void> {
                order.push("app");
                return Promise.resolve();
            }
        } as unknown as FastifyInstance;
        const services = {
            logger: new SilentLogger(),
            metadataCache: {
                close: function () {
                    order.push("metadata");
                }
            },
            assetCache: {
                close: function () {
                    order.push("asset");
                }
            }
        } as unknown as Services;

        await lifecycle.drain(services, app, idleInterval(), "SIGTERM", 1000, noopExit);

        // Reversing this turns every graceful restart into a scatter of failed downloads.
        expect(order).toEqual(["app", "metadata", "asset"]);
    });

    it("exits zero after a clean drain", async function () {
        const recorder = newRecorder();
        await lifecycle.drain(
            fakeServices(recorder),
            fakeApp(recorder),
            idleInterval(),
            "SIGTERM",
            1000,
            function (code) {
                recorder.released.push(String(code));
            }
        );
        expect(recorder.released).toEqual(["0"]);
    });

    it("closes the caches anyway when the drain exceeds its deadline", async function () {
        const recorder = newRecorder();
        // A deliberately slow app, so the drain deadline is what ends the wait rather than the app.
        await lifecycle.drain(
            fakeServices(recorder),
            fakeApp(recorder, 5000),
            idleInterval(),
            "SIGTERM",
            10,
            function (code) {
                recorder.released.push(String(code));
            }
        );

        // A hung request must not hold the process open forever, and must not leave the databases
        // open either.
        expect(recorder.closed).toBe(false);
        expect(recorder.metadataClosed).toBe(1);
        expect(recorder.assetClosed).toBe(1);
        expect(recorder.released).toEqual(["0"]);
    });

    it("stops the refresh interval so a drained process does not refetch", async function () {
        const recorder = newRecorder();
        const clearSpy = vi.spyOn(globalThis, "clearInterval");
        const interval = idleInterval();

        await lifecycle.drain(fakeServices(recorder), fakeApp(recorder), interval, "SIGTERM", 1000, noopExit);

        expect(clearSpy).toHaveBeenCalledWith(interval);
    });
});

describe("lifecycle startup", function () {
    it("warms the cache without waiting for it, and survives a warm failure", async function () {
        const recorder = newRecorder();
        const failing = function (): Promise<void> {
            return Promise.reject(new Error("github unreachable"));
        };
        const handle = lifecycle.startLifecycle(fakeServices(recorder, failing), fakeApp(recorder), {
            refreshIntervalMs: 60000,
            onExit: noopExit
        });
        await wait(10);

        // The server is already serving; a warm failure must not take it down. The first read that
        // finds nothing fetches on demand.
        expect(handle.interval).toBeDefined();
        handle.stop();
    });

    it("refetches on the refresh interval", async function () {
        const recorder = newRecorder();
        let warms = 0;
        const handle = lifecycle.startLifecycle(
            fakeServices(recorder, function () {
                warms = warms + 1;
                return Promise.resolve();
            }),
            fakeApp(recorder),
            { refreshIntervalMs: 5, onExit: noopExit }
        );

        await wait(40);
        handle.stop();

        // Without this the cache would only ever be refreshed by a request, which for a mirror with
        // no traffic means a stale updater response until someone visits the page.
        expect(warms).toBeGreaterThan(1);
    });

    it("keeps running when a periodic refresh fails", async function () {
        const recorder = newRecorder();
        const handle = lifecycle.startLifecycle(
            fakeServices(recorder, function () {
                return Promise.reject(new Error("github down"));
            }),
            fakeApp(recorder),
            { refreshIntervalMs: 5, onExit: noopExit }
        );

        // An unhandled rejection here would crash the process every five minutes.
        await wait(30);
        handle.stop();
    });

    it("drains once for repeated signals and ignores the rest", async function () {
        const recorder = newRecorder();
        const codes: number[] = [];
        const handle = lifecycle.startLifecycle(fakeServices(recorder), fakeApp(recorder), {
            refreshIntervalMs: 60000,
            onExit: function (code) {
                codes.push(code);
            }
        });

        try {
            process.emit("SIGTERM");
            // The second signal is a second request for the same thing. Acting on it would close the
            // databases underneath a request that is still reading them.
            process.emit("SIGTERM");
            process.emit("SIGINT");
            await wait(30);

            expect(recorder.metadataClosed).toBe(1);
            expect(codes).toEqual([0]);
        } finally {
            handle.stop();
        }
    });

    it("honours an explicit drain timeout", async function () {
        const recorder = newRecorder();
        const codes: number[] = [];
        const handle = lifecycle.startLifecycle(fakeServices(recorder), fakeApp(recorder, 5000), {
            refreshIntervalMs: 60000,
            drainTimeoutMs: 10,
            onExit: function (code) {
                codes.push(code);
            }
        });

        try {
            process.emit("SIGTERM");
            await wait(60);

            expect(recorder.closed).toBe(false);
            expect(recorder.metadataClosed).toBe(1);
            expect(codes).toEqual([0]);
        } finally {
            handle.stop();
        }
    });

    it("starts with production defaults when given no options", function () {
        const recorder = newRecorder();
        // This is the shape main.ts uses. No signal is emitted, so the default process exit is never
        // reached - only the option defaults are exercised.
        const handle = lifecycle.startLifecycle(fakeServices(recorder), fakeApp(recorder));

        expect(handle.interval).toBeDefined();
        expect(lifecycle.CACHE_REFRESH_INTERVAL_MS).toBeGreaterThan(0);
        expect(lifecycle.DRAIN_TIMEOUT_MS).toBeGreaterThan(0);
        handle.stop();
    });

    it("unhooks its signal handlers on stop", function () {
        const recorder = newRecorder();
        const before = process.listenerCount("SIGTERM");
        const handle = lifecycle.startLifecycle(fakeServices(recorder), fakeApp(recorder), {
            refreshIntervalMs: 60000,
            onExit: noopExit
        });
        expect(process.listenerCount("SIGTERM")).toBe(before + 1);

        handle.stop();

        // Left bound, a later signal would try to drain a server that has already been torn down.
        expect(process.listenerCount("SIGTERM")).toBe(before);
    });

    it("reports a shutdown failure and exits non-zero", function () {
        const recorder = newRecorder();
        const codes: number[] = [];
        const handler = lifecycle.reportShutdownFailure(fakeServices(recorder), function (code) {
            codes.push(code);
        });

        handler(new Error("close blew up"));

        expect(codes).toEqual([1]);
    });

    it("reports a non-Error rejection as a shutdown failure", function () {
        const recorder = newRecorder();
        const codes: number[] = [];
        const handler = lifecycle.reportShutdownFailure(fakeServices(recorder), function (code) {
            codes.push(code);
        });

        handler("just a string");

        expect(codes).toEqual([1]);
    });
});
