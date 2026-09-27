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

/**
 * Markdown rendering and syntax highlighting, split out so it can be fetched on demand.
 *
 * This module is most of the page's JavaScript, and the page's real content is a version number and
 * a list of file names - the notes are in a modal that most visitors never open. Importing this
 * eagerly meant every visitor downloaded ~130 KB of parser to render text they never asked for. The
 * modal imports it dynamically instead, so it costs a request only for someone who opens the notes,
 * and the first paint stops depending on it at all.
 *
 * Everything here is a static import on purpose: a dynamic import inside this module would turn one
 * request into a waterfall of them, which is the thing being avoided.
 */

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

/** Tags a release note may contain. Anything else is stripped. */
const ALLOWED_TAGS = [
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
];

const ALLOWED_ATTRS = ["href", "title", "target", "class"];

/**
 * Renders untrusted release-note markdown to sanitised HTML.
 *
 * The notes come from a GitHub repository this server mirrors, so they are author-controlled rather
 * than user-controlled - but they are still third-party input being handed to a browser, and a
 * release note is exactly the kind of text someone would paste a link into. Sanitising is cheap;
 * getting this wrong is not.
 */
export function renderReleaseNotes(source: string): string {
    // `async: false` is stated rather than assumed: marked returns a promise if any async extension
    // is configured, and this function is synchronous by contract because the dialog renders into
    // the DOM directly.
    const html = marked.parse(source, { async: false });
    return DOMPurifyNs.default(window).sanitize(html, {
        ADD_TAGS: ALLOWED_TAGS,
        ADD_ATTR: ALLOWED_ATTRS
    });
}

/** Applies syntax highlighting to the code blocks inside already-rendered notes. */
export function highlightCodeBlocks(root: HTMLElement): void {
    const blocks = root.querySelectorAll('pre code, code[class^="language-"]');
    for (let i = 0; i < blocks.length; i = i + 1) {
        hljs.highlightElement(blocks[i] as HTMLElement);
    }
}
