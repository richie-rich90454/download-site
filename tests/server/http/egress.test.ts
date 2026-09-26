import { describe, it, expect, vi, afterEach } from "vitest";
import * as stream from "node:stream";
import * as undici from "undici";
import * as egress from "../../../src/server/http/egress.js";

vi.mock("undici", function () {
    return {
        request: vi.fn(),
        Agent: class {
            close(): Promise<void> {
                return Promise.resolve();
            }
        }
    };
});

function bodyOf(payload: string): undici.Dispatcher.ResponseData["body"] {
    const readable = new stream.Readable({
        read: function () {
            this.push(Buffer.from(payload));
            this.push(null);
        }
    });
    // Real undici bodies expose dump(), which consumes the remainder and releases the socket.
    (readable as unknown as { dump: () => Promise<void> }).dump = function (): Promise<void> {
        return Promise.resolve();
    };
    return readable as unknown as undici.Dispatcher.ResponseData["body"];
}

function response(statusCode: number, headers: Record<string, string | string[]>): undici.Dispatcher.ResponseData {
    return {
        statusCode: statusCode,
        headers: headers,
        body: bodyOf("payload")
    } as unknown as undici.Dispatcher.ResponseData;
}

describe("egress.isAllowedAssetUrl", function () {
    it("accepts GitHub-owned hosts over https", function () {
        expect(egress.isAllowedAssetUrl("https://github.com/owner/repo/releases/download/v1/app.exe")).toBe(true);
        expect(egress.isAllowedAssetUrl("https://api.github.com/repos/owner/repo")).toBe(true);
        expect(egress.isAllowedAssetUrl("https://objects.githubusercontent.com/blob")).toBe(true);
        expect(egress.isAllowedAssetUrl("https://release-assets.githubusercontent.com/blob")).toBe(true);
        expect(egress.isAllowedAssetUrl("https://codeload.github.com/x")).toBe(true);
        expect(egress.isAllowedAssetUrl("https://githubusercontent.com.evil.test/x")).toBe(false);
    });

    it("rejects a host that only shares a suffix", function () {
        expect(egress.isAllowedAssetUrl("https://evilgithubusercontent.com/x")).toBe(false);
        expect(egress.isAllowedAssetUrl("https://notgithub.com/x")).toBe(false);
        expect(egress.isAllowedAssetUrl("https://github.com.evil.test/x")).toBe(false);
    });

    it("rejects loopback, link-local metadata and private ranges", function () {
        expect(egress.isAllowedAssetUrl("https://127.0.0.1/x")).toBe(false);
        expect(egress.isAllowedAssetUrl("https://169.254.169.254/latest/meta-data/")).toBe(false);
        expect(egress.isAllowedAssetUrl("https://10.0.0.5/x")).toBe(false);
        expect(egress.isAllowedAssetUrl("https://192.168.1.1/x")).toBe(false);
        expect(egress.isAllowedAssetUrl("https://localhost/x")).toBe(false);
        expect(egress.isAllowedAssetUrl("https://[::1]/x")).toBe(false);
    });

    it("rejects non-https schemes", function () {
        expect(egress.isAllowedAssetUrl("http://github.com/x")).toBe(false);
        expect(egress.isAllowedAssetUrl("file:///etc/passwd")).toBe(false);
        expect(egress.isAllowedAssetUrl("gopher://github.com/x")).toBe(false);
    });

    it("rejects a value that is not a URL at all", function () {
        expect(egress.isAllowedAssetUrl("not a url")).toBe(false);
        expect(egress.isAllowedAssetUrl("")).toBe(false);
    });

    it("is case insensitive about the host", function () {
        expect(egress.isAllowedAssetUrl("https://GitHub.com/x")).toBe(true);
        expect(egress.isAllowedAssetUrl("https://Objects.GitHubUserContent.com/x")).toBe(true);
    });
});

describe("egress.requestAsset", function () {
    afterEach(function () {
        vi.mocked(undici.request).mockReset();
    });

    it("returns a non-redirect response without following anything", async function () {
        vi.mocked(undici.request).mockResolvedValue(response(200, {}));
        const controller = new AbortController();

        const result = await egress.requestAsset("https://github.com/app.exe", { signal: controller.signal });

        expect(result.statusCode).toBe(200);
        expect(undici.request).toHaveBeenCalledTimes(1);
    });

    it("refuses a disallowed host before making any request", async function () {
        const controller = new AbortController();

        await expect(
            egress.requestAsset("https://169.254.169.254/latest/meta-data/", { signal: controller.signal })
        ).rejects.toThrow("unapproved host");
        expect(undici.request).not.toHaveBeenCalled();
    });

    it("validates every redirect hop, not just the first", async function () {
        vi.mocked(undici.request).mockResolvedValueOnce(
            response(302, { location: "https://169.254.169.254/latest/meta-data/" })
        );
        const controller = new AbortController();

        // The initial host is fine, so this proves the allowlist is re-applied after the hop.
        await expect(egress.requestAsset("https://github.com/app.exe", { signal: controller.signal })).rejects.toThrow(
            "unapproved host"
        );
        expect(undici.request).toHaveBeenCalledTimes(1);
    });

    it("resolves a relative redirect against the current URL", async function () {
        vi.mocked(undici.request)
            .mockResolvedValueOnce(response(302, { location: "/moved/app.exe" }))
            .mockResolvedValueOnce(response(200, {}));
        const controller = new AbortController();

        const result = await egress.requestAsset("https://github.com/owner/app.exe", { signal: controller.signal });

        expect(result.statusCode).toBe(200);
        const secondCall = vi.mocked(undici.request).mock.calls[1];
        expect(secondCall[0]).toBe("https://github.com/moved/app.exe");
    });

    it("takes the first entry when location is an array", async function () {
        vi.mocked(undici.request)
            .mockResolvedValueOnce(
                response(302, { location: ["https://objects.githubusercontent.com/a", "https://x.test/b"] })
            )
            .mockResolvedValueOnce(response(200, {}));
        const controller = new AbortController();

        await egress.requestAsset("https://github.com/app.exe", { signal: controller.signal });

        const secondCall = vi.mocked(undici.request).mock.calls[1];
        expect(secondCall[0]).toBe("https://objects.githubusercontent.com/a");
    });

    it("returns immediately when a redirect carries no location", async function () {
        vi.mocked(undici.request).mockResolvedValue(response(302, {}));
        const controller = new AbortController();

        const result = await egress.requestAsset("https://github.com/app.exe", { signal: controller.signal });

        expect(result.statusCode).toBe(302);
        expect(undici.request).toHaveBeenCalledTimes(1);
    });

    it("returns immediately when location is an empty array", async function () {
        vi.mocked(undici.request).mockResolvedValue(response(302, { location: [] }));
        const controller = new AbortController();

        const result = await egress.requestAsset("https://github.com/app.exe", { signal: controller.signal });

        expect(result.statusCode).toBe(302);
        expect(undici.request).toHaveBeenCalledTimes(1);
    });

    it("gives up after five redirects", async function () {
        vi.mocked(undici.request).mockResolvedValue(response(302, { location: "https://github.com/loop" }));
        const controller = new AbortController();

        await expect(egress.requestAsset("https://github.com/app.exe", { signal: controller.signal })).rejects.toThrow(
            "exceeded the redirect limit"
        );
        expect(undici.request).toHaveBeenCalledTimes(6);
    });

    it("passes request headers through", async function () {
        vi.mocked(undici.request).mockResolvedValue(response(206, {}));
        const controller = new AbortController();

        await egress.requestAsset("https://github.com/app.exe", {
            signal: controller.signal,
            headers: { Range: "bytes=0-99" }
        });

        const call = vi.mocked(undici.request).mock.calls[0];
        const options = call[1] as { headers: Record<string, string> };
        expect(options.headers.Range).toBe("bytes=0-99");
    });

    it("shares one bounded agent across requests", async function () {
        vi.mocked(undici.request).mockResolvedValue(response(200, {}));
        const controller = new AbortController();

        await egress.requestAsset("https://github.com/a.exe", { signal: controller.signal });
        await egress.requestAsset("https://github.com/b.exe", { signal: controller.signal });

        const first = vi.mocked(undici.request).mock.calls[0][1] as { dispatcher: unknown };
        const second = vi.mocked(undici.request).mock.calls[1][1] as { dispatcher: unknown };
        // Without a shared, bounded dispatcher undici opens one Client per concurrent request.
        expect(first.dispatcher).toBeDefined();
        expect(second.dispatcher).toBe(first.dispatcher);
    });

    it("propagates an abort from the caller's signal", async function () {
        vi.mocked(undici.request).mockImplementation(function () {
            return new Promise(function (_resolve, reject) {
                setTimeout(function () {
                    reject(new Error("aborted"));
                }, 50);
            });
        });
        const controller = new AbortController();
        const pending = egress.requestAsset("https://github.com/app.exe", { signal: controller.signal });
        controller.abort();

        await expect(pending).rejects.toThrow("aborted");
    });

    it("accepts an explicit timeout override", async function () {
        vi.mocked(undici.request).mockResolvedValue(response(200, {}));
        const controller = new AbortController();

        const result = await egress.requestAsset("https://github.com/app.exe", {
            signal: controller.signal,
            timeoutMs: 1000
        });

        expect(result.statusCode).toBe(200);
    });

    it("closes the shared pool", async function () {
        await expect(egress.closeAssetClient()).resolves.toBeUndefined();
    });
});
