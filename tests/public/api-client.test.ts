import { describe, test, expect, vi, afterEach } from "vitest";
import * as api from "../../src/public/api-client.js";

describe("api-client", function () {
    afterEach(function () {
        vi.restoreAllMocks();
    });

    test("fetchReleases returns releases", async function () {
        const release = {
            tag: "v1.0.0",
            name: "Release",
            notes: "Notes",
            publishedAt: "2024-01-01T00:00:00Z",
            prerelease: false,
            assets: []
        };
        const jsonMock = vi.fn().mockResolvedValue({ releases: [release] });
        vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, json: jsonMock }));
        const result = await api.fetchReleases("randmatqugea");
        expect(result.length).toBe(1);
        expect(result[0].tag).toBe("v1.0.0");
    });

    test("fetchReleases throws on error", async function () {
        vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, statusText: "Not Found" }));
        await expect(api.fetchReleases("randmatqugea")).rejects.toThrow("Failed to fetch releases");
    });

    test("fetchUpdate returns update", async function () {
        const update = {
            version: "v1.0.0",
            publishedAt: "2024-01-01T00:00:00Z",
            releaseNotes: "Notes",
            assets: []
        };
        const jsonMock = vi.fn().mockResolvedValue(update);
        vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, json: jsonMock }));
        const result = await api.fetchUpdate("randmatqugea", "v1.0.0");
        expect(result.version).toBe("v1.0.0");
    });

    test("fetchUpdate throws on error", async function () {
        vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, statusText: "Not Found" }));
        await expect(api.fetchUpdate("randmatqugea", "v1.0.0")).rejects.toThrow("Failed to fetch update");
    });

    test("fetchDownload returns blob", async function () {
        const blob = new Blob(["data"]);
        vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, blob: vi.fn().mockResolvedValue(blob) }));
        const result = await api.fetchDownload("randmatqugea", "v1.0.0", "app.exe");
        expect(result).toBe(blob);
    });

    test("fetchDownload throws on error", async function () {
        vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, statusText: "Not Found" }));
        await expect(api.fetchDownload("randmatqugea", "v1.0.0", "app.exe")).rejects.toThrow("Download failed");
    });

    test("fetchReleases returns empty array when releases is undefined", async function () {
        vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, json: vi.fn().mockResolvedValue({}) }));
        const result = await api.fetchReleases("randmatqugea");
        expect(result.length).toBe(0);
    });

    test("buildApiReleasesUrl contains origin and app", function () {
        vi.stubGlobal("location", { origin: "https://example.com" });
        const url = api.buildApiReleasesUrl("randmatqugea");
        expect(url.indexOf("https://example.com") >= 0).toBe(true);
        expect(url.indexOf("/api/releases/randmatqugea") >= 0).toBe(true);
    });

    test("buildApiUpdateUrl contains origin and app", function () {
        vi.stubGlobal("location", { origin: "https://example.com" });
        const url = api.buildApiUpdateUrl("randmatqugea");
        expect(url.indexOf("https://example.com") >= 0).toBe(true);
        expect(url.indexOf("/api/update/randmatqugea") >= 0).toBe(true);
    });

    test("buildDownloadUrl contains version and asset", function () {
        vi.stubGlobal("location", { origin: "https://example.com" });
        const url = api.buildDownloadUrl("randmatqugea", "v1.0.0", "app.exe");
        expect(url.indexOf("version=v1.0.0") >= 0).toBe(true);
        expect(url.indexOf("asset=app.exe") >= 0).toBe(true);
    });

    test("buildSmartDownloadUrl contains origin and version", function () {
        vi.stubGlobal("location", { origin: "https://example.com" });
        const url = api.buildSmartDownloadUrl("randmatqugea", "v1.0.0");
        expect(url.indexOf("https://example.com") >= 0).toBe(true);
        expect(url.indexOf("/download/randmatqugea") >= 0).toBe(true);
        expect(url.indexOf("version=v1.0.0") >= 0).toBe(true);
    });

    test("buildInstallCommand contains curl and url", function () {
        vi.stubGlobal("location", { origin: "https://example.com" });
        const command = api.buildInstallCommand("randmatqugea", "v1.0.0", "app.exe");
        expect(command.indexOf("curl -fsSL") >= 0).toBe(true);
        expect(command.indexOf("app.exe") >= 0).toBe(true);
    });
});
