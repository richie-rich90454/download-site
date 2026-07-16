import { describe, it, expect } from "vitest";
import * as types from "../../../src/shared/types.js";
import * as platform from "../../../src/server/platform/platform-detector.js";

function createAsset(name: string): types.Asset {
    return {
        name: name,
        size: 1,
        contentType: "application/octet-stream",
        url: "http://example.com/" + name,
        browserDownloadUrl: "http://example.com/" + name
    };
}

describe("DefaultPlatformDetector", function () {
    const detector = new platform.DefaultPlatformDetector();

    it("normalizes windows OS names", function () {
        expect(detector.normalizeOs("Windows 11")).toBe("windows");
        expect(detector.normalizeOs("win32")).toBe("windows");
    });

    it("normalizes macOS OS names", function () {
        expect(detector.normalizeOs("macOS")).toBe("darwin");
        expect(detector.normalizeOs("Darwin")).toBe("darwin");
        expect(detector.normalizeOs("Mac OS X")).toBe("darwin");
        expect(detector.normalizeOs("OSX")).toBe("darwin");
    });

    it("normalizes linux OS names", function () {
        expect(detector.normalizeOs("Linux")).toBe("linux");
        expect(detector.normalizeOs("Ubuntu Linux")).toBe("linux");
    });

    it("returns undefined for unknown OS", function () {
        expect(detector.normalizeOs("Solaris")).toBeUndefined();
    });

    it("normalizes arm64 architectures", function () {
        expect(detector.normalizeArch("arm64")).toBe("arm64");
        expect(detector.normalizeArch("aarch64")).toBe("arm64");
    });

    it("normalizes x64 architectures", function () {
        expect(detector.normalizeArch("x86_64")).toBe("x64");
        expect(detector.normalizeArch("amd64")).toBe("x64");
        expect(detector.normalizeArch("x64")).toBe("x64");
    });

    it("normalizes x86 architectures", function () {
        expect(detector.normalizeArch("x86")).toBe("x86");
        expect(detector.normalizeArch("i386")).toBe("x86");
        expect(detector.normalizeArch("i686")).toBe("x86");
    });

    it("detects target from User-Agent", function () {
        const target = detector.detectTarget("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36");

        expect(target.os).toBe("windows");
        expect(target.arch).toBe("x64");
    });

    it("uses platform hint override", function () {
        const target = detector.detectTarget("", "darwin_arm64");

        expect(target.os).toBe("darwin");
        expect(target.arch).toBe("arm64");
    });

    it("defaults to linux x64 when nothing matches", function () {
        const target = detector.detectTarget("", "");

        expect(target.os).toBe("linux");
        expect(target.arch).toBe("x64");
    });

    it("selects windows executable asset", function () {
        const assets = [
            createAsset("app-windows.exe"),
            createAsset("app-macos.dmg"),
            createAsset("app-linux.AppImage")
        ];
        const target: types.Target = { os: "windows", arch: "x64" };

        const selected = detector.selectAsset(assets, target);

        expect(selected).toBeDefined();
        expect(selected.name).toBe("app-windows.exe");
    });

    it("selects macOS dmg asset", function () {
        const assets = [
            createAsset("app-windows.exe"),
            createAsset("app-macos.dmg"),
            createAsset("app-linux.AppImage")
        ];
        const target: types.Target = { os: "darwin", arch: "x64" };

        const selected = detector.selectAsset(assets, target);

        expect(selected).toBeDefined();
        expect(selected.name).toBe("app-macos.dmg");
    });

    it("selects linux appimage asset", function () {
        const assets = [
            createAsset("app-windows.exe"),
            createAsset("app-macos.dmg"),
            createAsset("app-linux.AppImage")
        ];
        const target: types.Target = { os: "linux", arch: "x64" };

        const selected = detector.selectAsset(assets, target);

        expect(selected).toBeDefined();
        expect(selected.name).toBe("app-linux.AppImage");
    });

    it("prefers matching architecture", function () {
        const assets = [createAsset("app-windows-x64.exe"), createAsset("app-windows-arm64.exe")];
        const target: types.Target = { os: "windows", arch: "arm64" };

        const selected = detector.selectAsset(assets, target);

        expect(selected).toBeDefined();
        expect(selected.name).toBe("app-windows-arm64.exe");
    });

    it("gives bonus to universal macOS binaries", function () {
        const assets = [createAsset("app-macos-x64.dmg"), createAsset("app-macos-universal.dmg")];
        const target: types.Target = { os: "darwin", arch: "x64" };

        const selected = detector.selectAsset(assets, target);

        expect(selected).toBeDefined();
        expect(selected.name).toBe("app-macos-universal.dmg");
    });

    it("returns undefined when no asset matches OS", function () {
        const assets = [createAsset("app-windows.exe")];
        const target: types.Target = { os: "linux", arch: "x64" };

        const selected = detector.selectAsset(assets, target);

        expect(selected).toBeUndefined();
    });

    it("parses windows platform hints", function () {
        const target = detector.detectTarget("", "windows_x64");

        expect(target.os).toBe("windows");
        expect(target.arch).toBe("x64");
    });

    it("parses win platform hint", function () {
        const target = detector.detectTarget("", "win_arm64");

        expect(target.os).toBe("windows");
        expect(target.arch).toBe("arm64");
    });

    it("parses macos platform hint", function () {
        const target = detector.detectTarget("", "macos_x64");

        expect(target.os).toBe("darwin");
        expect(target.arch).toBe("x64");
    });

    it("parses linux platform hint", function () {
        const target = detector.detectTarget("", "linux_x86");

        expect(target.os).toBe("linux");
        expect(target.arch).toBe("x86");
    });

    it("falls back to linux when platform hint os is unknown", function () {
        const target = detector.detectTarget("", "unknown_arm64");

        expect(target.os).toBe("linux");
        expect(target.arch).toBe("arm64");
    });

    it("falls back to linux x64 when platform hint has no arch", function () {
        const target = detector.detectTarget("", "solaris");

        expect(target.os).toBe("linux");
        expect(target.arch).toBe("x64");
    });

    it("selects linux tar.gz asset", function () {
        const assets = [createAsset("app-linux.tar.gz")];
        const target: types.Target = { os: "linux", arch: "x64" };

        const selected = detector.selectAsset(assets, target);

        expect(selected).toBeDefined();
        expect(selected.name).toBe("app-linux.tar.gz");
    });

    it("selects darwin app asset", function () {
        const assets = [createAsset("app-mac.app")];
        const target: types.Target = { os: "darwin", arch: "x64" };

        const selected = detector.selectAsset(assets, target);

        expect(selected).toBeDefined();
        expect(selected.name).toBe("app-mac.app");
    });

    it("scores x64 target with arm64 name lower", function () {
        const assets = [createAsset("app-windows-arm64.exe")];
        const target: types.Target = { os: "windows", arch: "x64" };

        const selected = detector.selectAsset(assets, target);

        expect(selected).toBeDefined();
    });

    it("selects x86 asset", function () {
        const assets = [createAsset("app-windows-x86.exe")];
        const target: types.Target = { os: "windows", arch: "x86" };

        const selected = detector.selectAsset(assets, target);

        expect(selected).toBeDefined();
        expect(selected.name).toBe("app-windows-x86.exe");
    });
});
