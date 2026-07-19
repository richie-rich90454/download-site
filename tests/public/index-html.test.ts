import { describe, test, expect } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";

const indexPath = path.resolve(process.cwd(), "public", "index.html");
const html = fs.readFileSync(indexPath, "utf-8");

describe("public/index.html", function () {
    test("exists and contains the expected shell", function () {
        expect(html.indexOf('<div class="offline-banner is-hidden" id="offline-banner">') >= 0).toBe(true);
        expect(html.indexOf('<input id="release-search" type="search"') >= 0).toBe(true);
        expect(html.indexOf('<div id="app-grid" class="app-grid"></div>') >= 0).toBe(true);
        expect(html.indexOf('<div id="notes-modal" class="modal-backdrop"') >= 0).toBe(true);
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
});
