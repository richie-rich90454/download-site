// This file is the merge of two suites that covered the same class: this one and a second at
// src/server/platform/platform-detector.test.ts. The src/ copy had to go regardless - tsconfig.server.json
// includes src/server/**/*.ts, so a test file living there is emitted into dist/ as if it were runtime
// output. Its cases were folded in below, merged where they duplicated one rather than copied.
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

    it("returns undefined for unknown arch", function () {
        expect(detector.normalizeArch("riscv")).toBeUndefined();
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
        expect(detector.normalizeArch("win32")).toBe("x86");
    });

    it("detects target from User-Agent", function () {
        // The src/ copy of this suite had a "detects windows from user agent" case with this exact
        // user agent and these exact assertions. Same test, so it was dropped rather than repeated.
        const target = detector.detectTarget("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36");

        expect(target.os).toBe("windows");
        expect(target.arch).toBe("x64");
    });

    it("detects darwin from user agent", function () {
        const target = detector.detectTarget("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36");

        expect(target.os).toBe("darwin");
        expect(target.arch).toBe("x64");
    });

    it("detects linux from user agent", function () {
        const target = detector.detectTarget("Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36");

        expect(target.os).toBe("linux");
        expect(target.arch).toBe("x64");
    });

    it("uses platform hint override", function () {
        const target = detector.detectTarget("", "darwin_arm64");

        expect(target.os).toBe("darwin");
        expect(target.arch).toBe("arm64");
    });

    it("defaults to linux x64 when nothing matches", function () {
        // The hint check and the user agent check are separate guards, and either one on its own can be
        // the thing that comes up empty, so both entry points into the fallback are asserted here. The
        // src/ copy only covered the one that omits the hint argument.
        const noUserAgent = detector.detectTarget("");
        const emptyHint = detector.detectTarget("", "");

        expect(noUserAgent.os).toBe("linux");
        expect(noUserAgent.arch).toBe("x64");
        expect(emptyHint.os).toBe("linux");
        expect(emptyHint.arch).toBe("x64");
    });

    it("defaults to linux when user agent OS is unrecognized", function () {
        const target = detector.detectTarget("Mozilla/5.0", "");

        expect(target.os).toBe("linux");
        expect(target.arch).toBe("x64");
    });

    it("parses windows platform hints", function () {
        const target = detector.detectTarget("", "windows_x64");

        expect(target.os).toBe("windows");
        expect(target.arch).toBe("x64");
    });

    it("parses win platform hint", function () {
        // The src/ copy's "uses platform hint when provided" case used this hint and these assertions.
        // Same test, so it was dropped rather than repeated.
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

    it("uses x64 arch when platform hint omits arch", function () {
        const target = detector.detectTarget("", "windows");

        expect(target.os).toBe("windows");
        expect(target.arch).toBe("x64");
    });

    it("defaults to x64 when user agent architecture is unrecognized", function () {
        const target = detector.detectTarget("Mozilla/5.0 (X11; Linux x128)");

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
        expect(selected !== undefined ? selected.name : undefined).toBe("app-windows.exe");
    });

    it("selects windows asset by exe extension alone", function () {
        // Every name here is platform neutral, so only the extension can say which OS the asset is for.
        // The .dmg and .deb both carry the wanted arch, which must not be enough to win.
        const assets = [
            createAsset("myapp_x64-setup.exe"),
            createAsset("myapp_x64.dmg"),
            createAsset("myapp_amd64.deb")
        ];
        const target: types.Target = { os: "windows", arch: "x64" };

        const selected = detector.selectAsset(assets, target);

        expect(selected !== undefined ? selected.name : undefined).toBe("myapp_x64-setup.exe");
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
        expect(selected !== undefined ? selected.name : undefined).toBe("app-macos.dmg");
    });

    it("selects darwin asset by dmg extension alone", function () {
        // As above, decided by extension - and the winner is named aarch64, so this also covers the
        // aarch64 spelling being recognised as arm64 in an asset name rather than only in a hint.
        const assets = [createAsset("myapp.exe"), createAsset("myapp_aarch64.dmg"), createAsset("myapp.deb")];
        const target: types.Target = { os: "darwin", arch: "arm64" };

        const selected = detector.selectAsset(assets, target);

        expect(selected !== undefined ? selected.name : undefined).toBe("myapp_aarch64.dmg");
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
        expect(selected !== undefined ? selected.name : undefined).toBe("app-linux.AppImage");
    });

    it("selects linux asset by deb extension alone", function () {
        // The other two extensions are both the wrong OS for a linux target, so the deb is chosen on
        // its extension regardless of the amd64 in its name.
        const assets = [createAsset("myapp.exe"), createAsset("myapp.dmg"), createAsset("myapp_amd64.deb")];
        const target: types.Target = { os: "linux", arch: "x64" };

        const selected = detector.selectAsset(assets, target);

        expect(selected !== undefined ? selected.name : undefined).toBe("myapp_amd64.deb");
    });

    it("selects linux tar.gz asset", function () {
        const assets = [createAsset("app-linux.tar.gz")];
        const target: types.Target = { os: "linux", arch: "x64" };

        const selected = detector.selectAsset(assets, target);

        expect(selected).toBeDefined();
        expect(selected !== undefined ? selected.name : undefined).toBe("app-linux.tar.gz");
    });

    it("selects darwin app asset", function () {
        const assets = [createAsset("app-mac.app")];
        const target: types.Target = { os: "darwin", arch: "x64" };

        const selected = detector.selectAsset(assets, target);

        expect(selected).toBeDefined();
        expect(selected !== undefined ? selected.name : undefined).toBe("app-mac.app");
    });

    it("prefers matching architecture", function () {
        // The src/ copy's "prefers matching arch" case asserted the same thing over the same two
        // candidates with different filenames, so it was dropped rather than repeated.
        const assets = [createAsset("app-windows-x64.exe"), createAsset("app-windows-arm64.exe")];
        const target: types.Target = { os: "windows", arch: "arm64" };

        const selected = detector.selectAsset(assets, target);

        expect(selected).toBeDefined();
        expect(selected !== undefined ? selected.name : undefined).toBe("app-windows-arm64.exe");
    });

    it("prefers the windows keyword over a generic exe", function () {
        // Both assets are .exe, so the extension cannot separate them and only the name can. Without the
        // keyword match, list order would decide.
        const assets = [createAsset("app.exe"), createAsset("app-windows-x64.exe")];
        const target: types.Target = { os: "windows", arch: "x64" };

        const selected = detector.selectAsset(assets, target);

        expect(selected !== undefined ? selected.name : undefined).toBe("app-windows-x64.exe");
    });

    it("gives bonus to universal macOS binaries", function () {
        const assets = [createAsset("app-macos-x64.dmg"), createAsset("app-macos-universal.dmg")];
        const target: types.Target = { os: "darwin", arch: "x64" };

        const selected = detector.selectAsset(assets, target);

        expect(selected).toBeDefined();
        expect(selected !== undefined ? selected.name : undefined).toBe("app-macos-universal.dmg");
    });

    it("returns undefined when no asset matches OS", function () {
        // Both ways a candidate can score zero on OS: the only asset is for the wrong OS, and the set
        // has no asset for the target OS at all. The src/ copy covered the second, so it is merged in
        // here - a zero score has to return undefined rather than fall back to the first candidate.
        const target: types.Target = { os: "linux", arch: "x64" };
        const windowsTarget: types.Target = { os: "windows", arch: "x64" };

        const wrongOs = detector.selectAsset([createAsset("app-windows.exe")], target);
        const noneForTarget = detector.selectAsset([createAsset("app.dmg"), createAsset("app.deb")], windowsTarget);

        expect(wrongOs).toBeUndefined();
        expect(noneForTarget).toBeUndefined();
    });

    it("returns zero score for linux asset with unmatched extension", function () {
        const assets = [createAsset("app-linux.bin")];
        const target: types.Target = { os: "linux", arch: "x64" };

        const selected = detector.selectAsset(assets, target);

        expect(selected).toBeUndefined();
    });

    it("selects x86 asset", function () {
        const assets = [createAsset("app-windows-x86.exe")];
        const target: types.Target = { os: "windows", arch: "x86" };

        const selected = detector.selectAsset(assets, target);

        expect(selected).toBeDefined();
        expect(selected !== undefined ? selected.name : undefined).toBe("app-windows-x86.exe");
    });

    it("scores x64 target with arm64 name lower", function () {
        const assets = [createAsset("app-windows-arm64.exe")];
        const target: types.Target = { os: "windows", arch: "x64" };

        const selected = detector.selectAsset(assets, target);

        expect(selected).toBeDefined();
    });

    it("scores windows msi extension", function () {
        const assets = [createAsset("app-windows.msi")];
        const target: types.Target = { os: "windows", arch: "x64" };

        const selected = detector.selectAsset(assets, target);

        expect(selected).toBeDefined();
        expect(selected !== undefined ? selected.name : undefined).toBe("app-windows.msi");
    });

    it("scores windows zip extension", function () {
        const assets = [createAsset("app-windows.zip")];
        const target: types.Target = { os: "windows", arch: "x64" };

        const selected = detector.selectAsset(assets, target);

        expect(selected).toBeDefined();
        expect(selected !== undefined ? selected.name : undefined).toBe("app-windows.zip");
    });

    it("scores windows asset with unmatched extension by os only", function () {
        const assets = [createAsset("app-windows.bin")];
        const target: types.Target = { os: "windows", arch: "x64" };

        const selected = detector.selectAsset(assets, target);

        expect(selected).toBeDefined();
        expect(selected !== undefined ? selected.name : undefined).toBe("app-windows.bin");
    });

    it("scores darwin asset with unmatched extension by os only", function () {
        const assets = [createAsset("app-macos.bin")];
        const target: types.Target = { os: "darwin", arch: "x64" };

        const selected = detector.selectAsset(assets, target);

        expect(selected).toBeDefined();
        expect(selected !== undefined ? selected.name : undefined).toBe("app-macos.bin");
    });
});
