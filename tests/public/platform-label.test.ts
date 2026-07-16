import { describe, test, expect } from "vitest";
import { getPlatformLabel } from "../../src/public/platform-label.js";

describe("platform-label", function () {
    test("detects Windows x64", function () {
        expect(getPlatformLabel("app-windows-x64.exe")).toBe("Windows (x64)");
    });

    test("detects macOS ARM64", function () {
        expect(getPlatformLabel("app-mac-arm64.dmg")).toBe("macOS (ARM64)");
    });

    test("detects Linux x86", function () {
        expect(getPlatformLabel("app-linux-i386.deb")).toBe("Linux (x86)");
    });

    test("falls back to Other", function () {
        expect(getPlatformLabel("checksums.txt")).toBe("Other");
    });
});
