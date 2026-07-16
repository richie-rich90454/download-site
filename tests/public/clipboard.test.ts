import { describe, test, expect, vi, afterEach } from "vitest";
import { copyToClipboard } from "../../src/public/clipboard.js";

describe("clipboard", function () {
    afterEach(function () {
        vi.restoreAllMocks();
    });

    test("returns true when navigator clipboard succeeds", async function () {
        const writeText = vi.fn().mockResolvedValue(undefined);
        Object.defineProperty(navigator, "clipboard", {
            value: { writeText: writeText },
            configurable: true,
            writable: true
        });
        const result = await copyToClipboard("text");
        expect(result).toBe(true);
        expect(writeText).toHaveBeenCalledWith("text");
    });

    test("falls back to execCommand when navigator clipboard fails", async function () {
        Object.defineProperty(navigator, "clipboard", {
            value: { writeText: vi.fn().mockRejectedValue(new Error("denied")) },
            configurable: true,
            writable: true
        });
        const execCommand = vi.fn().mockReturnValue(true);
        document.execCommand = execCommand;
        const result = await copyToClipboard("fallback text");
        expect(result).toBe(true);
        expect(execCommand).toHaveBeenCalledWith("copy");
    });

    test("returns false when both methods fail", async function () {
        Object.defineProperty(navigator, "clipboard", {
            value: undefined,
            configurable: true,
            writable: true
        });
        const execCommand = vi.fn().mockReturnValue(false);
        document.execCommand = execCommand;
        const result = await copyToClipboard("fail text");
        expect(result).toBe(false);
    });

    test("returns false when execCommand throws", async function () {
        Object.defineProperty(navigator, "clipboard", {
            value: undefined,
            configurable: true,
            writable: true
        });
        const execCommand = vi.fn().mockImplementation(function () {
            throw new Error("denied");
        });
        document.execCommand = execCommand;
        const result = await copyToClipboard("throw text");
        expect(result).toBe(false);
    });
});
