import * as undici from "undici";

const MAX_REDIRECTS = 5;
const DEFAULT_TIMEOUT_MS = 300000;

/**
 * Bounded connection pool for every outbound request.
 *
 * Without an explicit dispatcher, undici creates one `Client` per concurrent request against
 * a given origin, so N simultaneous asset downloads meant N sockets and N TLS handshakes with
 * no ceiling. One shared Agent caps it. `pipelining: 1` keeps ordering predictable, which
 * matters because responses are streamed straight to the client.
 */
const AGENT = new undici.Agent({ connections: 8, pipelining: 1 });

/**
 * Hosts we are willing to fetch an asset from.
 *
 * Asset URLs come from the GitHub releases API, so in practice they are always GitHub-owned;
 * this list exists so that a future code path which accepts a user-supplied URL cannot turn
 * the server into a request proxy for internal services or cloud instance metadata. Matched as
 * exact host or as a dot-anchored suffix, so `evilgithubusercontent.com` cannot pass as
 * `githubusercontent.com`.
 */
const ALLOWED_HOSTS = ["github.com", "api.github.com", "codeload.github.com"];
const ALLOWED_SUFFIXES = [".githubusercontent.com", ".githubassets.com", ".blob.core.windows.net"];

function hostIsAllowed(hostname: string): boolean {
    const host = hostname.toLowerCase();
    for (let i = 0; i < ALLOWED_HOSTS.length; i = i + 1) {
        if (host === ALLOWED_HOSTS[i]) {
            return true;
        }
    }
    for (let i = 0; i < ALLOWED_SUFFIXES.length; i = i + 1) {
        if (host.endsWith(ALLOWED_SUFFIXES[i])) {
            return true;
        }
    }
    return false;
}

/**
 * Rejects anything that is not an https URL on an approved host. Called for the initial URL
 * and for every redirect target, so a redirect cannot be used to hop out of the allowlist.
 */
export function isAllowedAssetUrl(candidate: string): boolean {
    let parsed: URL;
    try {
        parsed = new URL(candidate);
    } catch {
        return false;
    }
    if (parsed.protocol !== "https:") {
        return false;
    }
    return hostIsAllowed(parsed.hostname);
}

function assertAllowedAssetUrl(candidate: string): void {
    if (!isAllowedAssetUrl(candidate)) {
        throw new Error("Refusing to fetch an asset from an unapproved host");
    }
}

function redirectTarget(currentUrl: string, location: string): string {
    return new URL(location, currentUrl).toString();
}

function isRedirect(statusCode: number): boolean {
    return statusCode >= 300 && statusCode < 400;
}

export interface AssetRequestOptions {
    signal: AbortSignal;
    headers?: Record<string, string>;
    timeoutMs?: number;
}

/**
 * Performs a GET, following redirects manually so that every hop can be validated and so the
 * intermediate body is always drained.
 *
 * The previous hand-rolled version followed `Location` without reading the 3xx body, holding
 * the socket out of the pool until garbage collection. Since every GitHub asset download is a
 * 302, that leaked one connection per hop, per download.
 */
export async function requestAsset(
    candidate: string,
    options: AssetRequestOptions
): Promise<undici.Dispatcher.ResponseData> {
    const timeoutMs = options.timeoutMs !== undefined ? options.timeoutMs : DEFAULT_TIMEOUT_MS;
    const controller = new AbortController();
    const timeout = setTimeout(function () {
        controller.abort();
    }, timeoutMs);
    const onOuterAbort = function (): void {
        controller.abort();
    };
    options.signal.addEventListener("abort", onOuterAbort, { once: true });
    let currentUrl = candidate;
    try {
        for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
            assertAllowedAssetUrl(currentUrl);
            const response = await undici.request(currentUrl, {
                method: "GET",
                signal: controller.signal,
                headers: options.headers,
                dispatcher: AGENT
            });
            if (!isRedirect(response.statusCode)) {
                return response;
            }
            const location = response.headers.location;
            if (location === undefined) {
                return response;
            }
            // Release the socket back to the pool before following.
            if (response.body !== null) {
                await response.body.dump();
            }
            const next = Array.isArray(location) ? location[0] : location;
            if (next === undefined) {
                return response;
            }
            currentUrl = redirectTarget(currentUrl, next);
        }
        throw new Error("Asset download exceeded the redirect limit");
    } finally {
        clearTimeout(timeout);
        options.signal.removeEventListener("abort", onOuterAbort);
    }
}

/** Closes the shared pool. Called on shutdown so the process can exit cleanly. */
export async function closeAssetClient(): Promise<void> {
    await AGENT.close();
}
