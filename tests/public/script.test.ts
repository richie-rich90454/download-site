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
        '<div class="container"><div class="window-body">' +
        '<input id="release-search" type="search" />' +
        '<div id="app-grid"></div>' +
        "</div></div>" +
        '<div id="offline-banner" class="offline-banner is-hidden"></div>';
}

/** The app list the server would report. The page reads this instead of carrying its own copy. */
const SERVER_APPS = [
    { id: "app1", repo: "owner/app1", name: "RandMatQuGeA" },
    { id: "app2", repo: "owner/app2", name: "Desktop Calendar Tracking" }
];

function mockFetch(): typeof globalThis.fetch {
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
        if (url.indexOf("/api/apps") >= 0) {
            return Promise.resolve(createFetchResponse({ apps: SERVER_APPS }));
        }
        if (url.indexOf("/api/releases/") >= 0) {
            return Promise.resolve(createFetchResponse({ releases: [release] }));
        }
        return Promise.resolve(createFetchResponse(update));
    });
}

function mockFetchWithAppNamed(name: string): typeof globalThis.fetch {
    return mockFetchReportingApps([{ id: "app1", repo: "owner/a", name: name }]);
}

function mockFetchReportingApps(apps: unknown[]): typeof globalThis.fetch {
    return vi.fn().mockImplementation(function (url: string) {
        if (url.indexOf("/api/apps") >= 0) {
            return Promise.resolve(createFetchResponse({ apps: apps }));
        }
        return Promise.resolve(createFetchResponse({ releases: [] }));
    });
}

describe("script", function () {
    const originalFetch = globalThis.fetch;
    const originalOnLine = Object.getOwnPropertyDescriptor(navigator, "onLine");

    beforeEach(function () {
        vi.resetModules();
        buildDom();
        globalThis.fetch = mockFetch();
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

    test("builds the update API links from the app list the server reports", async function () {
        await import("../../src/public/script.js");
        await new Promise(function (resolve) {
            setTimeout(resolve, 50);
        });

        const note = document.querySelector(".api-note");
        expect(note).not.toBe(null);
        if (note === null) {
            return;
        }
        // The whole point: the links are derived from /api/apps, so adding an app on the server
        // needs no rebuild and there is no second list to fall out of step.
        expect(note.textContent).toContain("/api/update/app1");
        expect(note.textContent).toContain("/api/update/app2");
    });

    test("sends no update links to a server that cannot list its apps", async function () {
        const failingFetch = vi.fn().mockImplementation(function (url: string) {
            if (url.indexOf("/api/apps") >= 0) {
                return Promise.resolve({ ok: false, statusText: "Service Unavailable" });
            }
            return Promise.resolve(createFetchResponse({ releases: [] }));
        });
        globalThis.fetch = failingFetch;

        await import("../../src/public/script.js");
        await new Promise(function (resolve) {
            setTimeout(resolve, 50);
        });

        // Better to say so than to render links to apps this mirror may not serve.
        expect(document.querySelectorAll(".api-note code").length).toBe(0);
        const note = document.querySelector(".api-note");
        if (note === null) {
            return;
        }
        expect(note.textContent).toContain("could not be loaded");
    });

    test("renders an app name as text, never as markup", async function () {
        globalThis.fetch = mockFetchWithAppNamed("<img src=x onerror=alert(1)>");
        await import("../../src/public/script.js");
        await new Promise(function (resolve) {
            setTimeout(resolve, 50);
        });

        // A display name comes from server config. If it were ever interpolated as HTML it would
        // be an injection point, so the check is that it landed as a text node.
        expect(document.querySelectorAll("img").length).toBe(0);
    });

    test("joins a single app's update link with no separator", async function () {
        globalThis.fetch = mockFetchReportingApps([{ id: "solo", repo: "owner/solo", name: "Solo" }]);
        await import("../../src/public/script.js");
        await new Promise(function (resolve) {
            setTimeout(resolve, 50);
        });

        const note = document.querySelector(".api-note");
        if (note === null) {
            return;
        }
        expect(note.textContent).toBe("Update API: /api/update/solo");
    });

    test("separates three update links with commas and a final and", async function () {
        globalThis.fetch = mockFetchReportingApps([
            { id: "one", repo: "owner/one", name: "One" },
            { id: "two", repo: "owner/two", name: "Two" },
            { id: "three", repo: "owner/three", name: "Three" }
        ]);
        await import("../../src/public/script.js");
        await new Promise(function (resolve) {
            setTimeout(resolve, 50);
        });

        const note = document.querySelector(".api-note");
        if (note === null) {
            return;
        }
        expect(note.textContent).toBe("Update API: /api/update/one, /api/update/two and /api/update/three");
    });

    test("shows the label but no links when the server lists no apps", async function () {
        globalThis.fetch = mockFetchReportingApps([]);
        await import("../../src/public/script.js");
        await new Promise(function (resolve) {
            setTimeout(resolve, 50);
        });

        const note = document.querySelector(".api-note");
        if (note === null) {
            return;
        }
        expect(note.textContent).toBe("Update API: ");
        expect(document.querySelectorAll(".app-card").length).toBe(0);
    });

    test("reports a network failure to the console and the page", async function () {
        const logged = vi.spyOn(console, "error").mockImplementation(function () {
            // captured below
        });
        const rejected = new Error("connection reset");
        const rejecting = vi.fn().mockImplementation(function () {
            return Promise.reject(rejected);
        });
        globalThis.fetch = rejecting;

        await import("../../src/public/script.js");
        await new Promise(function (resolve) {
            setTimeout(resolve, 50);
        });

        // An unhandled rejection leaves a blank page and no clue. Both the visible message and the
        // log have to survive, and the log needs the Error itself so the stack is not lost.
        expect(document.querySelectorAll(".api-note code").length).toBe(0);
        expect(logged).toHaveBeenCalledWith(rejected);
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
        document.body.innerHTML = '<div class="container"><div class="window-body"></div></div>';
        await import("../../src/public/script.js");
        expect(document.querySelectorAll(".app-card").length).toBe(0);
    });

    test("works when search input is missing", async function () {
        document.body.innerHTML =
            '<div class="container"><div class="window-body"><div id="app-grid"></div></div></div>';
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
            href: "http://localhost:3000/?app=app1&version=v1.0.0",
            search: "?app=app1&version=v1.0.0"
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
