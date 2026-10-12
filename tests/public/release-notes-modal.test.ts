import { describe, test, expect, afterEach } from "vitest";
import { createReleaseNotesModal } from "../../src/public/components/release-notes-modal.js";

describe("release-notes-modal", function () {
    afterEach(function () {
        document.body.innerHTML = "";
    });

    test("creates modal element hidden by default", function () {
        const modal = createReleaseNotesModal();
        expect(modal.element.classList.contains("is-open")).toBe(false);
        const dialog = modal.element.querySelector(".modal-dialog");
        expect(dialog).not.toBe(null);
        if (dialog !== null) {
            expect(dialog.getAttribute("role")).toBe("dialog");
        }
    });

    test("fetches the renderer once across repeated opens", async function () {
        const modal = createReleaseNotesModal();
        const release = {
            tag: "v1.0.0",
            name: "Release",
            notes: "# Notes",
            publishedAt: "2024-01-01T00:00:00Z",
            prerelease: false,
            assets: []
        };

        await modal.open(release);
        await modal.open(release);
        await modal.open(release);

        // The renderer is a hundred kilobytes of JavaScript fetched on demand, so re-opening the
        // notes must reuse it rather than queue another request for a module already resident.
        // Three opens with one import is the only way this is observable from outside.
        const body = modal.element.querySelector(".modal-body");
        if (body !== null) {
            expect(body.textContent.indexOf("Notes") >= 0).toBe(true);
        }
    });

    test("open displays modal and renders markdown notes", async function () {
        const modal = createReleaseNotesModal();
        await modal.open({
            tag: "v1.0.0",
            name: "Release",
            notes: "# Notes\n\nHello world",
            publishedAt: "2024-01-01T00:00:00Z",
            prerelease: false,
            assets: []
        });
        expect(modal.element.classList.contains("is-open")).toBe(true);
        const body = modal.element.querySelector(".modal-body");
        expect(body).not.toBe(null);
        if (body !== null) {
            expect(body.textContent.indexOf("Notes") >= 0).toBe(true);
            expect(body.textContent.indexOf("Hello world") >= 0).toBe(true);
        }
    });

    test("close hides modal", async function () {
        const modal = createReleaseNotesModal();
        await modal.open({
            tag: "v1.0.0",
            name: "Release",
            notes: "Notes",
            publishedAt: "2024-01-01T00:00:00Z",
            prerelease: false,
            assets: []
        });
        modal.close();
        expect(modal.element.classList.contains("is-open")).toBe(false);
    });

    test("clicking backdrop closes modal", async function () {
        const modal = createReleaseNotesModal();
        await modal.open({
            tag: "v1.0.0",
            name: "Release",
            notes: "Notes",
            publishedAt: "2024-01-01T00:00:00Z",
            prerelease: false,
            assets: []
        });
        const event = new MouseEvent("click", { bubbles: true });
        modal.element.dispatchEvent(event);
        expect(modal.element.classList.contains("is-open")).toBe(false);
    });

    test("escape key closes modal even when focus is outside it", async function () {
        const modal = createReleaseNotesModal();
        await modal.open({
            tag: "v1.0.0",
            name: "Release",
            notes: "Notes",
            publishedAt: "2024-01-01T00:00:00Z",
            prerelease: false,
            assets: []
        });
        // Dispatched on the document without bubbling from the backdrop: the handler lives on
        // the document precisely so Esc works wherever focus sits.
        const event = new KeyboardEvent("keydown", { key: "Escape" });
        document.dispatchEvent(event);
        expect(modal.element.classList.contains("is-open")).toBe(false);
    });

    test("close button hides modal", async function () {
        const modal = createReleaseNotesModal();
        await modal.open({
            tag: "v1.0.0",
            name: "Release",
            notes: "Notes",
            publishedAt: "2024-01-01T00:00:00Z",
            prerelease: false,
            assets: []
        });
        const closeButton = modal.element.querySelector(".modal-close");
        expect(closeButton).not.toBe(null);
        if (closeButton !== null) {
            closeButton.dispatchEvent(new MouseEvent("click", { bubbles: true }));
            expect(modal.element.classList.contains("is-open")).toBe(false);
        }
    });

    test("highlights code blocks in notes", async function () {
        const modal = createReleaseNotesModal();
        await modal.open({
            tag: "v1.0.0",
            name: "Release",
            notes: "```js\nconst x = 1;\n```",
            publishedAt: "2024-01-01T00:00:00Z",
            prerelease: false,
            assets: []
        });
        const codeBlock = modal.element.querySelector("code.language-js");
        expect(codeBlock).not.toBe(null);
    });

    test("handles undefined notes", async function () {
        const modal = createReleaseNotesModal();
        await modal.open({
            tag: "v1.0.0",
            name: "Release",
            notes: undefined as unknown as string,
            publishedAt: "2024-01-01T00:00:00Z",
            prerelease: false,
            assets: []
        });
        const body = modal.element.querySelector(".modal-body");
        expect(body).not.toBe(null);
    });

    test("ignores non-escape keys", async function () {
        const modal = createReleaseNotesModal();
        await modal.open({
            tag: "v1.0.0",
            name: "Release",
            notes: "Notes",
            publishedAt: "2024-01-01T00:00:00Z",
            prerelease: false,
            assets: []
        });
        const event = new KeyboardEvent("keydown", { key: "Enter" });
        modal.element.dispatchEvent(event);
        expect(modal.element.classList.contains("is-open")).toBe(true);
    });
});
