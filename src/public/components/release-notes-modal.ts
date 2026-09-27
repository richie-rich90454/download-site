import type { PublicRelease } from "../api-client.js";

export interface ReleaseNotesModal {
    element: HTMLElement;
    open(release: PublicRelease): Promise<void>;
    close(): void;
}

/**
 * The release-notes dialog.
 *
 * Rendering lives in a separate module that is imported on demand. The notes are in a modal most
 * visitors never open, and the renderer - marked, DOMPurify and a dozen highlight.js grammars - is
 * most of the page's JavaScript. Importing it here would make every visitor pay for text they never
 * asked to see, and would put it on the critical path of the first paint.
 */
export function createReleaseNotesModal(): ReleaseNotesModal {
    const backdrop = document.createElement("div");
    backdrop.className = "modal-backdrop";
    backdrop.setAttribute("role", "dialog");
    backdrop.setAttribute("aria-modal", "true");
    backdrop.setAttribute("aria-labelledby", "release-notes-title");
    backdrop.setAttribute("tabindex", "-1");
    backdrop.style.display = "none";

    const dialog = document.createElement("div");
    dialog.className = "modal-dialog";
    backdrop.appendChild(dialog);

    const header = document.createElement("div");
    header.className = "modal-header";

    const title = document.createElement("h2");
    title.id = "release-notes-title";
    title.className = "modal-title";
    header.appendChild(title);

    const closeButton = document.createElement("button");
    closeButton.type = "button";
    closeButton.className = "modal-close";
    closeButton.setAttribute("aria-label", "Close release notes");
    closeButton.addEventListener("click", function onCloseClick(): void {
        modal.close();
    });
    header.appendChild(closeButton);

    dialog.appendChild(header);

    const body = document.createElement("div");
    body.className = "modal-body release-notes";
    dialog.appendChild(body);

    document.body.appendChild(backdrop);

    // Held across calls so a second open before the first finishes reuses the request instead of
    // starting another one for a module that is a hundred kilobytes of JavaScript.
    let renderer: Promise<typeof import("./notes-renderer.js")> | null = null;

    async function loadRenderer(): Promise<typeof import("./notes-renderer.js")> {
        if (renderer === null) {
            renderer = import("./notes-renderer.js");
        }
        return renderer;
    }

    async function open(release: PublicRelease): Promise<void> {
        title.textContent = release.name + " (" + release.tag + ")";
        // The dialog appears before the await, so opening it is instant even on a slow connection
        // and the body says what is happening rather than sitting empty.
        backdrop.style.display = "flex";
        document.body.classList.add("modal-open");
        body.textContent = "Loading release notes...";
        backdrop.focus();

        const notes = release.notes !== undefined && release.notes !== null ? release.notes : "";
        try {
            const module = await loadRenderer();
            body.innerHTML = module.renderReleaseNotes(notes);
            module.highlightCodeBlocks(body);
        } catch {
            // A failed lazy import must not leave a dialog with nothing in it and no explanation.
            // The notes are plain text underneath, so they are shown as text rather than lost - and
            // as text they cannot execute anything, which is what the sanitiser was there to stop.
            body.textContent = "";
            const pre = document.createElement("pre");
            pre.textContent = notes;
            body.appendChild(pre);
        }
    }

    function close(): void {
        backdrop.style.display = "none";
        document.body.classList.remove("modal-open");
    }

    backdrop.addEventListener("click", function onBackdropClick(event: MouseEvent): void {
        if (event.target === backdrop) {
            modal.close();
        }
    });

    backdrop.addEventListener("keydown", function onKeydown(event: KeyboardEvent): void {
        if (event.key === "Escape") {
            modal.close();
        }
    });

    const modal: ReleaseNotesModal = {
        element: backdrop,
        open: open,
        close: close
    };
    return modal;
}
