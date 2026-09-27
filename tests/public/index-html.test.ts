import { describe, test, expect } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";

// The Vite entry, at the repository root. A copy also used to live in public/, but Vite copies
// that directory into dist/public and then overwrites its index.html with the built one, so the
// copy was never served and never read - only tested, which is worse than untested.
const indexPath = path.resolve(process.cwd(), "index.html");
const html = fs.readFileSync(indexPath, "utf-8");

describe("index.html", function () {
    test("exists and contains the expected shell", function () {
        expect(html.indexOf('id="offline-banner"') >= 0).toBe(true);
        expect(html.indexOf('id="release-search"') >= 0).toBe(true);
        expect(html.indexOf('<div id="app-grid" class="app-grid"></div>') >= 0).toBe(true);
        expect(html.indexOf('id="live-region"') >= 0).toBe(true);
    });

    test("labels the search input for screen readers", function () {
        // An unlabelled search box is invisible to a screen reader, so the label is part of the
        // contract rather than decoration.
        expect(html.indexOf('<label for="release-search">') >= 0).toBe(true);
    });

    test("declares a language and a responsive viewport", function () {
        expect(html.indexOf('<html lang="en">') >= 0).toBe(true);
        expect(html.indexOf('name="viewport"') >= 0).toBe(true);
    });

    test("does not contain a legacy inline script block", function () {
        const inlineScriptMatch = html.match(/<script\b[^>]*>([\s\S]*?)<\/script>/gi);
        if (inlineScriptMatch !== null) {
            for (let i = 0; i < inlineScriptMatch.length; i = i + 1) {
                const scriptTag = inlineScriptMatch[i];
                const hasSrc = /\bsrc\s*=/.test(scriptTag);
                expect(hasSrc).toBe(true);
            }
        }
    });

    test("contains the Vite module entry script", function () {
        expect(html.indexOf('<script type="module" src="/src/public/script.ts"></script>') >= 0).toBe(true);
    });

    test("names no app in the markup", function () {
        // The app list must come from the server, not from a copy in the HTML. A copy in the
        // markup goes stale the moment an app is added on the server, and this test is what stops
        // anyone from adding it back.
        expect(html).not.toContain("/api/update/");
        expect(html).not.toContain('app-grid">app');
    });
});
