/**
 * GCRA: the Generic Cell Rate Algorithm.
 *
 * Chosen over a fixed window because a fixed window either bursts at the boundary or needs
 * sliding-window bookkeeping. GCRA is O(1) time and O(1) space per key: it stores one number -
 * the theoretical arrival time of the next conforming request - and derives everything else.
 *
 * Cost:
 *   - emission interval T = period / limit
 *   - delay variation tolerance tau = burst * T
 *
 * A request is admitted when its theoretical arrival time is no later than now + tau. Admitting
 * it advances that time by T. Once the stored time falls behind now it is reset, so an idle key
 * costs nothing to keep.
 */

export interface GcraOptions {
    /** Sustained rate allowed per window. */
    limit: number;
    /** Window length in milliseconds. */
    periodMs: number;
    /** How many requests may arrive at once before the sustained rate applies. */
    burst: number;
}

export interface GcraDecision {
    allowed: boolean;
    /** Milliseconds until the next request would be admitted. Zero when allowed. */
    retryAfterMs: number;
    /** Requests currently permitted in the burst, for the human-facing 429 message. */
    remaining: number;
}

interface Bucket {
    /** Theoretical arrival time of the next conforming request, in milliseconds. */
    tat: number;
}

export class GcraLimiter {
    private readonly buckets: Map<string, Bucket>;
    private readonly emissionMs: number;
    private readonly toleranceMs: number;
    private readonly maxBuckets: number;
    private forcePruneNext: boolean;

    constructor(options: GcraOptions) {
        const burst = Math.max(options.burst, 1);
        this.emissionMs = options.periodMs / Math.max(options.limit, 1);
        // burst - 1, not burst: the accept path already advances the theoretical arrival time by
        // one emission interval, so counting the full burst here would admit burst + 1 requests.
        this.toleranceMs = (burst - 1) * this.emissionMs;
        this.maxBuckets = 20000;
        this.forcePruneNext = false;
        this.buckets = new Map();
    }

    check(key: string, now: number): GcraDecision {
        this.prune(now);
        const existing = this.buckets.get(key);
        const tat = existing !== undefined && existing.tat > now ? existing.tat : now;
        const allowAt = tat - this.toleranceMs;
        if (now < allowAt) {
            // Reaching here requires tat > now, which only a stored bucket can have, so there is
            // nothing to write back: the theoretical arrival time is already correct.
            return { allowed: false, retryAfterMs: Math.ceil(allowAt - now), remaining: 0 };
        }
        const bucket = existing !== undefined ? existing : { tat: now };
        bucket.tat = tat + this.emissionMs;
        this.store(key, bucket);
        return { allowed: true, retryAfterMs: 0, remaining: this.remaining(bucket.tat, now) };
    }

    /** How many further requests could be admitted at this instant. */
    private remaining(tat: number, now: number): number {
        const slack = Math.floor((now + this.toleranceMs - tat) / this.emissionMs) + 1;
        return slack > 0 ? slack : 0;
    }

    private store(key: string, bucket: Bucket): void {
        this.buckets.set(key, bucket);
        if (this.buckets.size > this.maxBuckets) {
            // Map iteration is insertion-ordered, so the first key is the least recently used.
            for (const oldest of this.buckets.keys()) {
                this.buckets.delete(oldest);
                break;
            }
        }
    }

    /**
     * Drops buckets whose allowance has fully recovered.
     *
     * Bounded by the cap above, and each prune walks at most the number of live keys, which is
     * amortised O(1) per request rather than O(n) per request.
     */
    private prune(now: number): void {
        if (this.buckets.size < 1000 && !this.forcePruneNext) {
            return;
        }
        this.forcePruneNext = false;
        const iterator = this.buckets.entries();
        let entry = iterator.next();
        while (entry.done !== true) {
            if (entry.value[1].tat - this.toleranceMs <= now) {
                this.buckets.delete(entry.value[0]);
            }
            entry = iterator.next();
        }
    }

    /** Exposed for the admin stats command: how many clients are currently tracked. */
    size(): number {
        return this.buckets.size;
    }

    /**
     * Drops recovered buckets on demand.
     *
     * check() prunes once a threshold is crossed, which is enough in production; this exists so
     * the eviction path can be exercised directly rather than through thousands of requests.
     */
    pruneNow(now: number): void {
        this.forcePruneNext = true;
        this.prune(now);
    }
}

/**
 * Per-route budgets.
 *
 * Downloads get a high ceiling and a large burst on purpose. A tight per-address cap is a
 * classist rule: an entire university, office, or mobile carrier sits behind a single NAT address,
 * so a hard limit punishes hundreds of innocent people for one person's request. Admin and
 * webhook routes stay tight because there is no legitimate burst there.
 */
export interface RateLimitBudgets {
    download: GcraOptions;
    api: GcraOptions;
    admin: GcraOptions;
}

export function defaultBudgets(): RateLimitBudgets {
    return {
        download: { limit: 600, periodMs: 60000, burst: 60 },
        api: { limit: 300, periodMs: 60000, burst: 30 },
        admin: { limit: 30, periodMs: 60000, burst: 5 }
    };
}
