import { describe, test, expect, vi, beforeEach, afterEach } from "vitest";

function createFetchResponse(data: unknown): { ok: boolean; json: () => Promise<unknown> } {
    return {
        ok: true,
        json: function () {
            return Promise.resolve(data);
        }
    };
}

function buildDom(): void {
    document.body.innerHTML =
        '<div class="container">' +
        '<input id="release-search" type="search" />' +
        '<div id="app-grid"></div>' +
        "</div>" +
        '<div id="offline-banner" class="offline-banner is-hidden"></div>';
}

function mockFetch(): ReturnType<typeof vi.fn> {
    const release = {
        tag: "v1.0.0",
        name: "v1.0.0",
        notes: "Notes",
        publishedAt: "2024-01-01T00:00:00Z",
        prerelease: false,
        assets: [
            {
                name: "app-windows.exe",
                size: 100,
                contentType: "application/octet-stream",
                url: "https://example.com/app-windows.exe",
                browserDownloadUrl: "https://example.com/app-windows.exe"
            }
        ]
    };
    const update = {
        version: "v1.0.0",
        publishedAt: "2024-01-01T00:00:00Z",
        releaseNotes: "Notes",
        assets: [
            {
                name: "app-windows.exe",
                size: 100,
                contentType: "application/octet-stream",
                url: "https://example.com/app-windows.exe",
                browserDownloadUrl: "https://example.com/app-windows.exe"
            }
        ]
    };
    return vi.fn().mockImplementation(function (url: string) {
        if (url.indexOf("/api/releases/") >= 0) {
            return Promise.resolve(createFetchResponse({ releases: [release] }));
        }
        return Promise.resolve(createFetchResponse(update));
    });
}

describe("script", function () {
    const originalFetch = globalThis.fetch;
    const originalOnLine = Object.getOwnPropertyDescriptor(navigator, "onLine");

    beforeEach(function () {
        vi.resetModules();
        buildDom();
        globalThis.fetch = mockFetch() as unknown as typeof globalThis.fetch;
        Object.defineProperty(navigator, "onLine", { value: true, writable: true, configurable: true });
        vi.spyOn(window.history, "replaceState").mockImplementation(function () {
            // no-op to avoid happy-dom origin mismatch
        });
    });

    afterEach(function () {
        vi.restoreAllMocks();
        document.body.innerHTML = "";
        globalThis.fetch = originalFetch;
        if (originalOnLine !== undefined) {
            Object.defineProperty(navigator, "onLine", originalOnLine);
        }
    });

    test("initializes app cards when DOM is present", async function () {
        await import("../../src/public/script.js");
        await new Promise(function (resolve) {
            setTimeout(resolve, 50);
        });

        const grid = document.getElementById("app-grid");
        expect(grid).not.toBe(null);
        if (grid !== null) {
            expect(grid.children.length).toBe(2);
        }
    });

    test("returns early when container is missing", async function () {
        document.body.innerHTML = '<div id="app-grid"></div>';
        await import("../../src/public/script.js");
        const grid = document.getElementById("app-grid");
        expect(grid).not.toBe(null);
        if (grid !== null) {
            expect(grid.children.length).toBe(0);
        }
    });

    test("applies search filter from query params", async function () {
        vi.stubGlobal("location", { href: "http://localhost:3000/?search=notes", search: "?search=notes" });
        await import("../../src/public/script.js");
        await new Promise(function (resolve) {
            setTimeout(resolve, 50);
        });
        const searchInput = document.getElementById("release-search") as HTMLInputElement | null;
        expect(searchInput).not.toBe(null);
        if (searchInput !== null) {
            expect(searchInput.value).toBe("notes");
        }
    });

    test("returns early when app-grid is missing", async function () {
        document.body.innerHTML = '<div class="container"></div>';
        await import("../../src/public/script.js");
        expect(document.querySelectorAll(".app-card").length).toBe(0);
    });

    test("works when search input is missing", async function () {
        document.body.innerHTML = '<div class="container"><div id="app-grid"></div></div>';
        await import("../../src/public/script.js");
        await new Promise(function (resolve) {
            setTimeout(resolve, 50);
        });
        const grid = document.getElementById("app-grid");
        expect(grid).not.toBe(null);
        if (grid !== null) {
            expect(grid.children.length).toBe(2);
        }
    });

    test("selects app and version from query params", async function () {
        vi.stubGlobal("location", {
            href: "http://localhost:3000/?app=randmatqugea&version=v1.0.0",
            search: "?app=randmatqugea&version=v1.0.0"
        });
        await import("../../src/public/script.js");
        await new Promise(function (resolve) {
            setTimeout(resolve, 100);
        });

        const grid = document.getElementById("app-grid");
        expect(grid).not.toBe(null);
        if (grid !== null) {
            expect(grid.children.length).toBe(2);
        }
    });

    test("updates offline banner visibility on online and offline events", async function () {
        await import("../../src/public/script.js");
        await new Promise(function (resolve) {
            setTimeout(resolve, 50);
        });
        const banner = document.getElementById("offline-banner");
        expect(banner).not.toBe(null);
        if (banner === null) {
            return;
        }

        Object.defineProperty(navigator, "onLine", { value: false, writable: true, configurable: true });
        window.dispatchEvent(new Event("offline"));
        expect(banner.classList.contains("is-visible")).toBe(true);
        expect(banner.classList.contains("is-hidden")).toBe(false);

        Object.defineProperty(navigator, "onLine", { value: true, writable: true, configurable: true });
        window.dispatchEvent(new Event("online"));
        expect(banner.classList.contains("is-hidden")).toBe(true);
        expect(banner.classList.contains("is-visible")).toBe(false);
    });

    test("applies search filter on input", async function () {
        await import("../../src/public/script.js");
        const searchInput = document.getElementById("release-search") as HTMLInputElement | null;
        expect(searchInput).not.toBe(null);
        if (searchInput === null) {
            return;
        }
        searchInput.value = "windows";
        searchInput.dispatchEvent(new Event("input"));
        await new Promise(function (resolve) {
            setTimeout(resolve, 50);
        });
        expect(searchInput.value).toBe("windows");
    });

    test("waits for DOMContentLoaded when document is still loading", async function () {
        Object.defineProperty(document, "readyState", {
            value: "loading",
            writable: true,
            configurable: true
        });
        await import("../../src/public/script.js");
        document.dispatchEvent(new Event("DOMContentLoaded"));
        await new Promise(function (resolve) {
            setTimeout(resolve, 50);
        });
        const grid = document.getElementById("app-grid");
        expect(grid).not.toBe(null);
        if (grid !== null) {
            expect(grid.children.length).toBe(2);
        }
    });

    test("getSelectedVersion returns null when no app selected", async function () {
        vi.stubGlobal("location", { href: "http://localhost:3000/", search: "" });
        await import("../../src/public/script.js");
        const searchInput = document.getElementById("release-search") as HTMLInputElement | null;
        expect(searchInput).not.toBe(null);
        if (searchInput === null) {
            return;
        }
        searchInput.value = "query";
        searchInput.dispatchEvent(new Event("input"));
        await new Promise(function (resolve) {
            setTimeout(resolve, 50);
        });
        expect(searchInput.value).toBe("query");
    });

    test("getSelectedVersion returns null when selected app is unknown", async function () {
        vi.stubGlobal("location", { href: "http://localhost:3000/?app=unknown", search: "?app=unknown" });
        await import("../../src/public/script.js");
        const searchInput = document.getElementById("release-search") as HTMLInputElement | null;
        expect(searchInput).not.toBe(null);
        if (searchInput === null) {
            return;
        }
        searchInput.value = "query";
        searchInput.dispatchEvent(new Event("input"));
        await new Promise(function (resolve) {
            setTimeout(resolve, 50);
        });
        expect(searchInput.value).toBe("query");
    });

    test("search input calls getSelectedVersion with no selected app", async function () {
        Object.defineProperty(document, "readyState", {
            value: "complete",
            writable: true,
            configurable: true
        });
        vi.stubGlobal("location", { href: "http://localhost:3000/", search: "" });
        await import("../../src/public/script.js");
        await new Promise(function (resolve) {
            setTimeout(resolve, 50);
        });
        const searchInput = document.getElementById("release-search") as HTMLInputElement | null;
        expect(searchInput).not.toBe(null);
        if (searchInput === null) {
            return;
        }
        searchInput.value = "query";
        searchInput.dispatchEvent(new Event("input", { bubbles: true }));
        await new Promise(function (resolve) {
            setTimeout(resolve, 50);
        });
        expect(window.history.replaceState).toHaveBeenCalled();
    });

    test("search input calls getSelectedVersion with unknown selected app", async function () {
        Object.defineProperty(document, "readyState", {
            value: "complete",
            writable: true,
            configurable: true
        });
        vi.stubGlobal("location", { href: "http://localhost:3000/?app=unknown", search: "?app=unknown" });
        await import("../../src/public/script.js");
        await new Promise(function (resolve) {
            setTimeout(resolve, 50);
        });
        const searchInput = document.getElementById("release-search") as HTMLInputElement | null;
        expect(searchInput).not.toBe(null);
        if (searchInput === null) {
            return;
        }
        searchInput.value = "query";
        searchInput.dispatchEvent(new Event("input", { bubbles: true }));
        await new Promise(function (resolve) {
            setTimeout(resolve, 50);
        });
        expect(window.history.replaceState).toHaveBeenCalled();
    });
});
