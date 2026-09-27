/**
 * A counting semaphore.
 *
 * Exists because a single 2 vCPU box cannot usefully fetch many multi-megabyte assets at once:
 * past a handful, throughput stops improving and every concurrent download is holding a socket, a
 * write stream and a temp file. The bound is what turns "as many as arrive" into a queue.
 *
 * Deliberately not a class hierarchy or a plugin - the one thing needed is a way to await a slot.
 */
export class Semaphore {
    private readonly limit: number;
    private available: number;
    private readonly waiting: (() => void)[];

    constructor(limit: number) {
        if (!Number.isInteger(limit) || limit < 1) {
            throw new Error("Semaphore limit must be a positive integer");
        }
        this.limit = limit;
        this.available = limit;
        this.waiting = [];
    }

    /**
     * Resolves once a slot is free.
     *
     * Queues rather than rejecting: a download that arrived over the limit is not an error, it is
     * the normal case when several users request the same release moments after it is published.
     */
    async acquire(): Promise<void> {
        if (this.available > 0) {
            this.available = this.available - 1;
            return;
        }
        const self = this;
        await new Promise<void>(function (resolve) {
            self.waiting.push(resolve);
        });
    }

    release(): void {
        const next = this.waiting.shift();
        if (next !== undefined) {
            // The slot passes straight to the next waiter. A slot that went back to the pool instead
            // would let one new caller jump the queue every release.
            next();
            return;
        }
        this.available = Math.min(this.available + 1, this.limit);
    }

    /** Runs `work` while holding a slot, releasing it even if `work` throws. */
    async run<T>(work: () => Promise<T>): Promise<T> {
        await this.acquire();
        try {
            return await work();
        } finally {
            this.release();
        }
    }

    get queued(): number {
        return this.waiting.length;
    }
}
