import type { PublicRelease } from "../api-client.js";
import * as markedNs from "marked";
import * as DOMPurifyNs from "dompurify";
import hljs from "highlight.js/lib/core";
import bash from "highlight.js/lib/languages/bash";
import css from "highlight.js/lib/languages/css";
import diff from "highlight.js/lib/languages/diff";
import ini from "highlight.js/lib/languages/ini";
import javascript from "highlight.js/lib/languages/javascript";
import json from "highlight.js/lib/languages/json";
import markdown from "highlight.js/lib/languages/markdown";
import plaintext from "highlight.js/lib/languages/plaintext";
import powershell from "highlight.js/lib/languages/powershell";
import python from "highlight.js/lib/languages/python";
import rust from "highlight.js/lib/languages/rust";
import shell from "highlight.js/lib/languages/shell";
import typescript from "highlight.js/lib/languages/typescript";
import xml from "highlight.js/lib/languages/xml";

const marked = markedNs.marked;

/**
 * Only the languages a release note realistically contains.
 *
 * Importing the `highlight.js` barrel pulls in every bundled grammar - around 190 of them, and
 * roughly 1 MB of JavaScript on the critical path for a page whose real content is a version
 * number and a list of file names. That is a bad trade for anyone on a slow connection, so the
 * core is used and grammars are registered explicitly.
 *
 * `plaintext` is registered as the fallback: an unregistered language degrades to unhighlighted
 * text rather than throwing, so a note in an unexpected language still renders safely.
 */
hljs.registerLanguage("bash", bash);
hljs.registerLanguage("css", css);
hljs.registerLanguage("diff", diff);
hljs.registerLanguage("ini", ini);
hljs.registerLanguage("javascript", javascript);
hljs.registerLanguage("json", json);
hljs.registerLanguage("markdown", markdown);
hljs.registerLanguage("plaintext", plaintext);
hljs.registerLanguage("powershell", powershell);
hljs.registerLanguage("python", python);
hljs.registerLanguage("rust", rust);
hljs.registerLanguage("shell", shell);
hljs.registerLanguage("typescript", typescript);
hljs.registerLanguage("xml", xml);

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
