import type { PublicRelease } from "../api-client.js";
import * as markedNs from "marked";
import * as DOMPurifyNs from "dompurify";
import hljs from "highlight.js";

const marked = markedNs.marked;

function createPurify() {
    return DOMPurifyNs.default(window);
}

export interface ReleaseNotesModal {
    element: HTMLElement;
    open(release: PublicRelease): Promise<void>;
    close(): void;
}

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
    closeButton.textContent = "\u00D7";
    closeButton.addEventListener("click", function onCloseClick(): void {
        modal.close();
    });
    header.appendChild(closeButton);

    dialog.appendChild(header);

    const body = document.createElement("div");
    body.className = "modal-body release-notes";
    dialog.appendChild(body);

    document.body.appendChild(backdrop);

    async function open(release: PublicRelease): Promise<void> {
        title.textContent = release.name + " (" + release.tag + ")";
        const notes = release.notes !== undefined && release.notes !== null ? release.notes : "";
        const html = await marked.parse(notes);
        const purify = createPurify();
        const clean = purify.sanitize(html, {
            ADD_TAGS: [
                "h1",
                "h2",
                "h3",
                "h4",
                "h5",
                "h6",
                "p",
                "br",
                "hr",
                "ul",
                "ol",
                "li",
                "code",
                "pre",
                "strong",
                "em",
                "a",
                "blockquote"
            ],
            ADD_ATTR: ["href", "title", "target", "class"]
        });
        body.innerHTML = clean;
        const codeBlocks = body.querySelectorAll('pre code, code[class^="language-"]');
        for (let i = 0; i < codeBlocks.length; i = i + 1) {
            hljs.highlightElement(codeBlocks[i] as HTMLElement);
        }
        backdrop.style.display = "flex";
        backdrop.focus();
        document.body.classList.add("modal-open");
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
