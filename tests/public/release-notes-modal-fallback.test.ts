import { describe, test, expect, afterEach, vi } from "vitest";

/**
 * The failure path for the lazily-imported notes renderer.
 *
 * In its own file because the module is mocked for the whole file: a mock declared in the main
 * suite would take the working path with it, and the point here is that the *broken* path still
 * leaves the reader with their notes.
 */
vi.mock("../../src/public/components/notes-renderer.js", function () {
    return {
        renderReleaseNotes: function () {
            // What a chunk load failure looks like from inside the try block.
            throw new Error("chunk load failed");
        },
        highlightCodeBlocks: function () {
            // Not reached.
        }
    };
});

// vi.mock is hoisted above imports by vitest's transform, so a plain import here is already bound
// to the mock. A top-level await would read more obviously but is not available at this project's
// target.
import { createReleaseNotesModal } from "../../src/public/components/release-notes-modal.js";

describe("release-notes-modal when the renderer cannot be loaded", function () {
    afterEach(function () {
        document.body.innerHTML = "";
    });

    test("falls back to showing the notes as text", async function () {
        const modal = createReleaseNotesModal();

        await modal.open({
            tag: "v1.0.0",
            name: "Release",
            notes: "# Heading\n\nSome **notes**",
            publishedAt: "2024-01-01T00:00:00Z",
            prerelease: false,
            assets: []
        });

        // The dialog is open and has content. A failed lazy import must not leave a modal with
        // nothing in it, which reads as a broken page rather than a failed download.
        expect(modal.element.style.display).toBe("flex");
        const body = modal.element.querySelector(".modal-body");
        expect(body).not.toBe(null);
        if (body !== null) {
            expect(body.textContent.indexOf("Heading") >= 0).toBe(true);
            expect(body.textContent.indexOf("Some **notes**") >= 0).toBe(true);
        }
    });

    test("falls back for an empty note too", async function () {
        const modal = createReleaseNotesModal();

        await modal.open({
            tag: "v2.0.0",
            name: "Release",
            notes: "",
            publishedAt: "2024-02-01T00:00:00Z",
            prerelease: false,
            assets: []
        });

        expect(modal.element.style.display).toBe("flex");
    });
});
