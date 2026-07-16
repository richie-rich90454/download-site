import { describe, test, expect, afterEach } from "vitest";
import { createReleaseNotesModal } from "../../src/public/components/release-notes-modal.js";

describe("release-notes-modal", function () {
    afterEach(function () {
        document.body.innerHTML = "";
    });

    test("creates modal element hidden by default", function () {
        const modal = createReleaseNotesModal();
        expect(modal.element.style.display).toBe("none");
        expect(modal.element.getAttribute("role")).toBe("dialog");
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
        expect(modal.element.style.display).toBe("flex");
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
        expect(modal.element.style.display).toBe("none");
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
        expect(modal.element.style.display).toBe("none");
    });

    test("escape key closes modal", async function () {
        const modal = createReleaseNotesModal();
        await modal.open({
            tag: "v1.0.0",
            name: "Release",
            notes: "Notes",
            publishedAt: "2024-01-01T00:00:00Z",
            prerelease: false,
            assets: []
        });
        const event = new KeyboardEvent("keydown", { key: "Escape" });
        modal.element.dispatchEvent(event);
        expect(modal.element.style.display).toBe("none");
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
            expect(modal.element.style.display).toBe("none");
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
        expect(modal.element.style.display).toBe("flex");
    });
});
