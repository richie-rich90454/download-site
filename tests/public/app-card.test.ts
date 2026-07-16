import { describe, test, expect, vi, afterEach, beforeEach } from "vitest";
import { createStore } from "../../src/public/state.js";
import { createReleaseNotesModal } from "../../src/public/components/release-notes-modal.js";
import { createAppCard } from "../../src/public/components/app-card.js";
import type { PublicRelease, UpdateResponse } from "../../src/public/api-client.js";

function createFetchResponse(data: unknown): { ok: boolean; json: () => Promise<unknown> } {
    return {
        ok: true,
        json: function () {
            return Promise.resolve(data);
        }
    };
}

describe("app-card", function () {
    let store: ReturnType<typeof createStore>;
    let modal: ReturnType<typeof createReleaseNotesModal>;
    let fetchMock: ReturnType<typeof vi.fn>;

    beforeEach(function () {
        store = createStore();
        modal = createReleaseNotesModal();
        fetchMock = vi.fn().mockResolvedValue(createFetchResponse({ releases: [] }));
        window.fetch = fetchMock as unknown as typeof window.fetch;
    });

    afterEach(function () {
        vi.restoreAllMocks();
        document.body.innerHTML = "";
    });

    test("renders card element with data-app", function () {
        const card = createAppCard(store, modal, "randmatqugea", "RandMatQuGeA");
        expect(card.element.getAttribute("data-app")).toBe("randmatqugea");
        const heading = card.element.querySelector("h2");
        expect(heading).not.toBe(null);
        if (heading !== null) {
            expect(heading.textContent).toBe("RandMatQuGeA");
        }
    });

    test("renders loading skeleton while loading", function () {
        const card = createAppCard(store, modal, "randmatqugea", "RandMatQuGeA");
        store.setLoading("randmatqugea");
        const skeleton = card.element.querySelector(".skeleton-stack");
        expect(skeleton).not.toBe(null);
    });

    test("renders error boundary on error", function () {
        const card = createAppCard(store, modal, "randmatqugea", "RandMatQuGeA");
        store.setError("randmatqugea", "Something broke");
        const errorBox = card.element.querySelector(".error-boundary");
        expect(errorBox).not.toBe(null);
        if (errorBox !== null) {
            expect(errorBox.textContent.indexOf("Something broke") >= 0).toBe(true);
        }
    });

    test("renders version selector from releases", async function () {
        const release: PublicRelease = {
            tag: "v1.0.0",
            name: "v1.0.0",
            notes: "Notes",
            publishedAt: "2024-01-01T00:00:00Z",
            prerelease: false,
            assets: []
        };
        const update: UpdateResponse = {
            version: "v1.0.0",
            publishedAt: "2024-01-01T00:00:00Z",
            releaseNotes: "Notes",
            assets: []
        };
        fetchMock.mockImplementation(function (url: string) {
            if (url.indexOf("/api/releases/") >= 0) {
                return Promise.resolve(createFetchResponse({ releases: [release] }));
            }
            return Promise.resolve(createFetchResponse(update));
        });
        const card = createAppCard(store, modal, "randmatqugea", "RandMatQuGeA");
        await card.load();
        const select = card.element.querySelector("select");
        expect(select).not.toBe(null);
        if (select !== null) {
            expect(select.options.length).toBe(1);
            expect(select.options[0].value).toBe("v1.0.0");
        }
    });

    test("renders action buttons from update data", async function () {
        const release: PublicRelease = {
            tag: "v1.0.0",
            name: "v1.0.0",
            notes: "Notes",
            publishedAt: "2024-01-01T00:00:00Z",
            prerelease: false,
            assets: []
        };
        const update: UpdateResponse = {
            version: "v1.0.0",
            publishedAt: "2024-01-01T00:00:00Z",
            releaseNotes: "Notes",
            assets: [
                {
                    name: "app-windows-x64.exe",
                    size: 1024,
                    contentType: "application/x-msdownload",
                    url: "https://example.com/asset.exe",
                    browserDownloadUrl: "https://example.com/asset.exe"
                }
            ]
        };
        fetchMock.mockImplementation(function (url: string) {
            if (url.indexOf("/api/releases/") >= 0) {
                return Promise.resolve(createFetchResponse({ releases: [release] }));
            }
            return Promise.resolve(createFetchResponse(update));
        });
        const card = createAppCard(store, modal, "randmatqugea", "RandMatQuGeA");
        await card.load();
        const buttons = card.element.querySelectorAll(".button-group a");
        expect(buttons.length >= 2).toBe(true);
        expect(buttons[0].textContent).toBe("Smart Download");
        expect(buttons[1].textContent).toBe("Windows (x64)");
    });

    test("filters release list by search term", async function () {
        const release1: PublicRelease = {
            tag: "v1.0.0",
            name: "v1.0.0",
            notes: "first release",
            publishedAt: "2024-01-01T00:00:00Z",
            prerelease: false,
            assets: []
        };
        const release2: PublicRelease = {
            tag: "v2.0.0",
            name: "v2.0.0",
            notes: "second release",
            publishedAt: "2024-02-01T00:00:00Z",
            prerelease: false,
            assets: []
        };
        const update: UpdateResponse = {
            version: "v2.0.0",
            publishedAt: "2024-02-01T00:00:00Z",
            releaseNotes: "Notes",
            assets: []
        };
        fetchMock.mockImplementation(function (url: string) {
            if (url.indexOf("/api/releases/") >= 0) {
                return Promise.resolve(createFetchResponse({ releases: [release1, release2] }));
            }
            return Promise.resolve(createFetchResponse(update));
        });
        const card = createAppCard(store, modal, "randmatqugea", "RandMatQuGeA");
        await card.load();
        store.setFilter("second");
        const items = card.element.querySelectorAll(".release-list-item");
        expect(items.length).toBe(1);
        if (items.length > 0) {
            expect(items[0].textContent.indexOf("v2.0.0") >= 0).toBe(true);
        }
    });

    test("sets selected app on focusin", async function () {
        const card = createAppCard(store, modal, "randmatqugea", "RandMatQuGeA");
        card.element.dispatchEvent(new Event("focusin"));
        expect(store.getState().selectedAppName).toBe("randmatqugea");
    });

    test("opens release notes modal when notes button clicked", async function () {
        const release: PublicRelease = {
            tag: "v1.0.0",
            name: "v1.0.0",
            notes: "Notes",
            publishedAt: "2024-01-01T00:00:00Z",
            prerelease: false,
            assets: []
        };
        const update: UpdateResponse = {
            version: "v1.0.0",
            publishedAt: "2024-01-01T00:00:00Z",
            releaseNotes: "Notes",
            assets: []
        };
        fetchMock.mockImplementation(function (url: string) {
            if (url.indexOf("/api/releases/") >= 0) {
                return Promise.resolve(createFetchResponse({ releases: [release] }));
            }
            return Promise.resolve(createFetchResponse(update));
        });
        const card = createAppCard(store, modal, "randmatqugea", "RandMatQuGeA");
        await card.load();
        const notesButton = card.element.querySelector(".release-list-item button");
        expect(notesButton).not.toBe(null);
        if (notesButton !== null) {
            notesButton.click();
            await new Promise(function (resolve) {
                setTimeout(resolve, 50);
            });
            expect(modal.element.style.display).toBe("flex");
        }
    });

    test("copies install command when copy button clicked", async function () {
        const release: PublicRelease = {
            tag: "v1.0.0",
            name: "v1.0.0",
            notes: "Notes",
            publishedAt: "2024-01-01T00:00:00Z",
            prerelease: false,
            assets: []
        };
        const update: UpdateResponse = {
            version: "v1.0.0",
            publishedAt: "2024-01-01T00:00:00Z",
            releaseNotes: "Notes",
            assets: [
                {
                    name: "app-windows-x64.exe",
                    size: 1024,
                    contentType: "application/x-msdownload",
                    url: "https://example.com/asset.exe",
                    browserDownloadUrl: "https://example.com/asset.exe"
                }
            ]
        };
        fetchMock.mockImplementation(function (url: string) {
            if (url.indexOf("/api/releases/") >= 0) {
                return Promise.resolve(createFetchResponse({ releases: [release] }));
            }
            return Promise.resolve(createFetchResponse(update));
        });
        vi.stubGlobal("navigator", {
            clipboard: {
                writeText: vi.fn().mockResolvedValue(undefined)
            },
            onLine: true
        });
        const card = createAppCard(store, modal, "randmatqugea", "RandMatQuGeA");
        await card.load();
        const copyButton = Array.from(card.element.querySelectorAll(".btn-copy")).find(function (button) {
            return button.textContent === "Copy install command";
        }) as HTMLButtonElement | undefined;
        expect(copyButton).not.toBeUndefined();
        if (copyButton !== undefined) {
            copyButton.click();
            await new Promise(function (resolve) {
                setTimeout(resolve, 50);
            });
            expect(copyButton.textContent).toBe("Copied!");
        }
    });

    test("changes version when selector changes", async function () {
        const release: PublicRelease = {
            tag: "v1.0.0",
            name: "v1.0.0",
            notes: "Notes",
            publishedAt: "2024-01-01T00:00:00Z",
            prerelease: false,
            assets: []
        };
        const update: UpdateResponse = {
            version: "v1.0.0",
            publishedAt: "2024-01-01T00:00:00Z",
            releaseNotes: "Notes",
            assets: []
        };
        fetchMock.mockImplementation(function (url: string) {
            if (url.indexOf("/api/releases/") >= 0) {
                return Promise.resolve(createFetchResponse({ releases: [release] }));
            }
            return Promise.resolve(createFetchResponse(update));
        });
        const card = createAppCard(store, modal, "randmatqugea", "RandMatQuGeA");
        await card.load();
        const select = card.element.querySelector("select");
        expect(select).not.toBe(null);
        if (select !== null) {
            select.value = "v1.0.0";
            select.dispatchEvent(new Event("change"));
            await new Promise(function (resolve) {
                setTimeout(resolve, 50);
            });
            expect(store.getState().apps[0].selectedVersion).toBe("v1.0.0");
        }
    });

    test("retries loading when retry button clicked", async function () {
        fetchMock.mockRejectedValue(new Error("network error"));
        const card = createAppCard(store, modal, "randmatqugea", "RandMatQuGeA");
        await card.load();
        const retryButton = card.element.querySelector(".error-boundary button");
        expect(retryButton).not.toBe(null);
        fetchMock.mockResolvedValue(createFetchResponse({ releases: [] }));
        if (retryButton !== null) {
            retryButton.dispatchEvent(new MouseEvent("click", { bubbles: true }));
            await new Promise(function (resolve) {
                setTimeout(resolve, 50);
            });
            expect(fetchMock).toHaveBeenCalled();
        }
    });

    test("shows copy failed when clipboard fails", async function () {
        const release: PublicRelease = {
            tag: "v1.0.0",
            name: "v1.0.0",
            notes: "Notes",
            publishedAt: "2024-01-01T00:00:00Z",
            prerelease: false,
            assets: []
        };
        const update: UpdateResponse = {
            version: "v1.0.0",
            publishedAt: "2024-01-01T00:00:00Z",
            releaseNotes: "Notes",
            assets: [
                {
                    name: "app-windows-x64.exe",
                    size: 1024,
                    contentType: "application/x-msdownload",
                    url: "https://example.com/asset.exe",
                    browserDownloadUrl: "https://example.com/asset.exe"
                }
            ]
        };
        fetchMock.mockImplementation(function (url: string) {
            if (url.indexOf("/api/releases/") >= 0) {
                return Promise.resolve(createFetchResponse({ releases: [release] }));
            }
            return Promise.resolve(createFetchResponse(update));
        });
        vi.stubGlobal("navigator", {
            clipboard: {
                writeText: vi.fn().mockRejectedValue(new Error("denied"))
            },
            onLine: true
        });
        const card = createAppCard(store, modal, "randmatqugea", "RandMatQuGeA");
        await card.load();
        const copyButton = Array.from(card.element.querySelectorAll(".btn-copy")).find(function (button) {
            return button.textContent === "Copy install command";
        }) as HTMLButtonElement | undefined;
        expect(copyButton).not.toBeUndefined();
        if (copyButton !== undefined) {
            copyButton.click();
            await new Promise(function (resolve) {
                setTimeout(resolve, 50);
            });
            expect(copyButton.textContent).toBe("Copy failed");
        }
    });

    test("renders empty message when no releases are available", function () {
        const card = createAppCard(store, modal, "randmatqugea", "RandMatQuGeA");
        store.setReleases("randmatqugea", []);
        store.setUpdate("randmatqugea", {
            version: "",
            publishedAt: "",
            releaseNotes: "",
            assets: []
        });
        const empty = card.element.querySelector(".app-card__content > p");
        expect(empty).not.toBe(null);
        if (empty !== null) {
            expect(empty.textContent).toBe("No releases available.");
        }
    });

    test("renders smart download only when update data is null", function () {
        const card = createAppCard(store, modal, "randmatqugea", "RandMatQuGeA");
        store.setReleases("randmatqugea", [
            {
                tag: "v1.0.0",
                name: "v1.0.0",
                notes: "Notes",
                publishedAt: "2024-01-01T00:00:00Z",
                prerelease: false,
                assets: []
            }
        ]);
        const buttons = card.element.querySelectorAll(".button-group a");
        expect(buttons.length).toBe(1);
        expect(buttons[0].textContent).toBe("Smart Download");
    });

    test("handles load update rejection with non-error", async function () {
        const release: PublicRelease = {
            tag: "v1.0.0",
            name: "v1.0.0",
            notes: "Notes",
            publishedAt: "2024-01-01T00:00:00Z",
            prerelease: false,
            assets: []
        };
        fetchMock.mockImplementation(function (url: string) {
            if (url.indexOf("/api/releases/") >= 0) {
                return Promise.resolve(createFetchResponse({ releases: [release] }));
            }
            // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors
            return Promise.reject("update failure");
        });
        const card = createAppCard(store, modal, "randmatqugea", "RandMatQuGeA");
        await card.load();
        expect(store.getState().apps[0].status).toBe("error");
        expect(store.getState().apps[0].errorMessage).toBe("update failure");
    });

    test("handles load releases rejection with non-error", async function () {
        fetchMock.mockImplementation(function () {
            // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors
            return Promise.reject("releases failure");
        });
        const card = createAppCard(store, modal, "randmatqugea", "RandMatQuGeA");
        await card.load();
        expect(store.getState().apps[0].status).toBe("error");
        expect(store.getState().apps[0].errorMessage).toBe("releases failure");
    });

    test("restores copy button label after timeout", async function () {
        const release: PublicRelease = {
            tag: "v1.0.0",
            name: "v1.0.0",
            notes: "Notes",
            publishedAt: "2024-01-01T00:00:00Z",
            prerelease: false,
            assets: []
        };
        const update: UpdateResponse = {
            version: "v1.0.0",
            publishedAt: "2024-01-01T00:00:00Z",
            releaseNotes: "Notes",
            assets: [
                {
                    name: "app-windows-x64.exe",
                    size: 1024,
                    contentType: "application/x-msdownload",
                    url: "https://example.com/asset.exe",
                    browserDownloadUrl: "https://example.com/asset.exe"
                }
            ]
        };
        fetchMock.mockImplementation(function (url: string) {
            if (url.indexOf("/api/releases/") >= 0) {
                return Promise.resolve(createFetchResponse({ releases: [release] }));
            }
            return Promise.resolve(createFetchResponse(update));
        });
        vi.stubGlobal("navigator", {
            clipboard: {
                writeText: vi.fn().mockResolvedValue(undefined)
            },
            onLine: true
        });
        const card = createAppCard(store, modal, "randmatqugea", "RandMatQuGeA");
        await card.load();
        const copyButton = Array.from(card.element.querySelectorAll(".btn-copy")).find(function (button) {
            return button.textContent === "Copy install command";
        }) as HTMLButtonElement | undefined;
        expect(copyButton).not.toBeUndefined();
        if (copyButton !== undefined) {
            copyButton.click();
            await new Promise(function (resolve) {
                setTimeout(resolve, 1600);
            });
            expect(copyButton.textContent).toBe("Copy install command");
        }
    });

    test("renders no releases match message when filter is active", async function () {
        const release1: PublicRelease = {
            tag: "v1.0.0",
            name: "v1.0.0",
            notes: "first release",
            publishedAt: "2024-01-01T00:00:00Z",
            prerelease: false,
            assets: []
        };
        const release2: PublicRelease = {
            tag: "v2.0.0",
            name: "v2.0.0",
            notes: "second release",
            publishedAt: "2024-02-01T00:00:00Z",
            prerelease: false,
            assets: []
        };
        const update: UpdateResponse = {
            version: "v2.0.0",
            publishedAt: "2024-02-01T00:00:00Z",
            releaseNotes: "Notes",
            assets: []
        };
        fetchMock.mockImplementation(function (url: string) {
            if (url.indexOf("/api/releases/") >= 0) {
                return Promise.resolve(createFetchResponse({ releases: [release1, release2] }));
            }
            return Promise.resolve(createFetchResponse(update));
        });
        const card = createAppCard(store, modal, "randmatqugea", "RandMatQuGeA");
        await card.load();
        store.setFilter("nomatch");
        const empty = card.element.querySelector(".release-list-empty");
        expect(empty).not.toBe(null);
        if (empty !== null) {
            expect(empty.textContent).toBe("No releases match your filter.");
        }
    });

    test("returns early from render when app state is missing", async function () {
        const card = createAppCard(store, modal, "randmatqugea", "RandMatQuGeA");
        await card.load();
        const state = store.getState();
        state.apps = [];
        store.setFilter("trigger");
        const content = card.element.querySelector(".app-card__content");
        expect(content).not.toBe(null);
    });

    test("handles load update rejection with error object", async function () {
        const release: PublicRelease = {
            tag: "v1.0.0",
            name: "v1.0.0",
            notes: "Notes",
            publishedAt: "2024-01-01T00:00:00Z",
            prerelease: false,
            assets: []
        };
        fetchMock.mockImplementation(function (url: string) {
            if (url.indexOf("/api/releases/") >= 0) {
                return Promise.resolve(createFetchResponse({ releases: [release] }));
            }
            return Promise.reject(new Error("update error"));
        });
        const card = createAppCard(store, modal, "randmatqugea", "RandMatQuGeA");
        await card.load();
        expect(store.getState().apps[0].status).toBe("error");
        expect(store.getState().apps[0].errorMessage).toBe("update error");
    });

    test("renders version selector without matching selected option", function () {
        const release: PublicRelease = {
            tag: "v1.0.0",
            name: "v1.0.0",
            notes: "Notes",
            publishedAt: "2024-01-01T00:00:00Z",
            prerelease: false,
            assets: []
        };
        const card = createAppCard(store, modal, "randmatqugea", "RandMatQuGeA");
        store.setReleases("randmatqugea", [release]);
        store.selectVersion("randmatqugea", "v2.0.0");
        store.setUpdate("randmatqugea", {
            version: "v2.0.0",
            publishedAt: "2024-01-01T00:00:00Z",
            releaseNotes: "Notes",
            assets: []
        });
        const select = card.element.querySelector("select");
        expect(select).not.toBe(null);
        if (select !== null) {
            expect(select.options.length).toBe(1);
            expect(select.options[0].value).toBe("v1.0.0");
            expect(select.value).not.toBe("v2.0.0");
        }
    });
});
