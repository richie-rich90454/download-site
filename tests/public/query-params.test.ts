import { describe, test, expect, vi, afterEach } from "vitest";
import { parseQueryParams, updateQueryParams } from "../../src/public/query-params.js";

describe("query-params", function () {
    afterEach(function () {
        vi.restoreAllMocks();
    });

    test("parseQueryParams reads app version and search", function () {
        vi.stubGlobal("location", { search: "?app=randmatqugea&version=v1.0.0&search=windows" });
        const params = parseQueryParams();
        expect(params.app).toBe("randmatqugea");
        expect(params.version).toBe("v1.0.0");
        expect(params.search).toBe("windows");
    });

    test("parseQueryParams returns null for missing params", function () {
        vi.stubGlobal("location", { search: "" });
        const params = parseQueryParams();
        expect(params.app).toBe(null);
        expect(params.version).toBe(null);
        expect(params.search).toBe(null);
    });

    test("updateQueryParams sets params", function () {
        const replaceState = vi.fn();
        vi.stubGlobal("history", { replaceState: replaceState });
        vi.stubGlobal("location", { href: "https://example.com/" });
        updateQueryParams("randmatqugea", "v1.0.0", "windows");
        const url = replaceState.mock.calls[0][2] as string;
        expect(url.indexOf("app=randmatqugea") >= 0).toBe(true);
        expect(url.indexOf("version=v1.0.0") >= 0).toBe(true);
        expect(url.indexOf("search=windows") >= 0).toBe(true);
    });

    test("updateQueryParams removes empty params", function () {
        const replaceState = vi.fn();
        vi.stubGlobal("history", { replaceState: replaceState });
        vi.stubGlobal("location", { href: "https://example.com/?app=old&version=old&search=old" });
        updateQueryParams("", "", "");
        const url = replaceState.mock.calls[0][2] as string;
        expect(url.indexOf("app=") < 0).toBe(true);
        expect(url.indexOf("version=") < 0).toBe(true);
        expect(url.indexOf("search=") < 0).toBe(true);
    });
});
