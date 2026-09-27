import * as net from "node:net";

/**
 * Cloudflare edge networks, as published at
 * https://www.cloudflare.com/ips-v4 and https://www.cloudflare.com/ips-v6
 *
 * Refresh these when Cloudflare announces a change; they move rarely. Shipping the list is what
 * makes trusting a forwarding header conditional on the peer actually being Cloudflare, so the
 * design stays correct whether or not the origin has been firewalled yet.
 */
const CLOUDFLARE_IPV4 = [
    "173.245.48.0/20",
    "103.21.244.0/22",
    "103.22.200.0/22",
    "103.31.4.0/22",
    "141.101.64.0/18",
    "108.162.192.0/18",
    "190.93.240.0/20",
    "188.114.96.0/20",
    "197.234.240.0/20",
    "198.41.128.0/17",
    "162.158.0.0/15",
    "104.16.0.0/13",
    "104.24.0.0/14",
    "172.64.0.0/13",
    "131.0.72.0/22"
];

const CLOUDFLARE_IPV6 = [
    "2400:cb00::/32",
    "2606:4700::/32",
    "2803:f800::/32",
    "2405:b500::/32",
    "2405:8100::/32",
    "2a06:98c0::/29",
    "2c0f:f248::/32"
];

let cloudflareBlockList: net.BlockList | undefined;

/** Built once, lazily, so importing this module costs nothing. */
function cloudflareNetworks(): net.BlockList {
    if (cloudflareBlockList === undefined) {
        const list = new net.BlockList();
        for (let i = 0; i < CLOUDFLARE_IPV4.length; i += 1) {
            const parts = CLOUDFLARE_IPV4[i].split("/");
            list.addSubnet(parts[0], parseInt(parts[1], 10), "ipv4");
        }
        for (let i = 0; i < CLOUDFLARE_IPV6.length; i += 1) {
            const parts = CLOUDFLARE_IPV6[i].split("/");
            list.addSubnet(parts[0], parseInt(parts[1], 10), "ipv6");
        }
        cloudflareBlockList = list;
    }
    return cloudflareBlockList;
}

/** Strips the IPv4-mapped IPv6 form so ::ffff:1.2.3.4 compares equal to 1.2.3.4. */
function normalise(address: string): string {
    const trimmed = address.trim().toLowerCase();
    if (trimmed.indexOf("::ffff:") === 0) {
        return trimmed.substring(7);
    }
    return trimmed;
}

export function isCloudflareAddress(address: string | undefined): boolean {
    if (address === undefined || address.length === 0) {
        return false;
    }
    const candidate = normalise(address);
    if (net.isIPv4(candidate)) {
        return cloudflareNetworks().check(candidate, "ipv4");
    }
    if (net.isIPv6(candidate)) {
        return cloudflareNetworks().check(candidate, "ipv6");
    }
    return false;
}

export interface ClientIpResult {
    /** Key to rate limit and correlate on. Never a value the client could have forged. */
    clientId: string;
    /** True only when the request genuinely arrived through Cloudflare. */
    viaCloudflare: boolean;
    /** Why the header was not used, for the startup diagnostics an operator actually needs. */
    reason: string;
}

/**
 * Resolves the client identity for rate limiting and logging.
 *
 * With no trust proxy configured, the socket peer behind Cloudflare is the edge node, so every
 * visitor on that POP shares one rate-limit bucket and a hundred requests from anyone locks out
 * everyone else.
 *
 * The tempting fix is `trustProxy: true`, which is worse: Cloudflare appends to X-Forwarded-For,
 * so a client can prepend a forged address and the app would read the forged value. That also lets
 * a flood of forged keys evict real clients' buckets from the limiter's store.
 *
 * So the header is honoured only when the socket peer is a genuine Cloudflare address. That is
 * correct whether or not the origin has been firewalled to Cloudflare's ranges: an un-firewalled
 * origin simply never takes the trusted path and falls back to the socket peer, which is the
 * safe, if less granular, behaviour.
 */
export function resolveClientId(peerAddress: string | undefined, headers: Record<string, unknown>): ClientIpResult {
    const peer = peerAddress !== undefined && peerAddress.length > 0 ? normalise(peerAddress) : undefined;
    if (peer === undefined) {
        return { clientId: "unknown", viaCloudflare: false, reason: "no peer address" };
    }
    if (!isCloudflareAddress(peer)) {
        return { clientId: peer, viaCloudflare: false, reason: "peer is not a Cloudflare address" };
    }
    const header = headers["cf-connecting-ip"];
    const forwarded: unknown = Array.isArray(header) ? header[0] : header;
    if (typeof forwarded !== "string" || forwarded.length === 0) {
        return { clientId: peer, viaCloudflare: true, reason: "no cf-connecting-ip header" };
    }
    const candidate = normalise(forwarded);
    if (net.isIP(candidate) === 0) {
        return { clientId: peer, viaCloudflare: true, reason: "cf-connecting-ip is not an address" };
    }
    return { clientId: candidate, viaCloudflare: true, reason: "resolved through Cloudflare" };
}

/**
 * A short, non-reversible token standing in for a client address.
 *
 * Data minimisation: a log line needs to distinguish one client from another, not identify them.
 * A per-process salted digest cannot be reversed into an address, and because the salt changes
 * on restart the same visitor is not correlatable across restarts.
 */
export function anonymizeAddress(address: string, salt: string): string {
    let hash = 2166136261;
    const input = salt + "|" + address;
    for (let i = 0; i < input.length; i += 1) {
        hash = hash ^ input.charCodeAt(i);
        hash = Math.imul(hash, 16777619) >>> 0;
    }
    return hash.toString(16).padStart(8, "0");
}
