import { describe, expect, it } from "vitest";
import { DefaultPlatformDetector } from "./platform-detector.js";
import type { Asset, Target } from "../../shared/types.js";

function asset(name: string): Asset {
    return {
        name: name,
        size: 0,
        contentType: "application/octet-stream",
        url: "",
        browserDownloadUrl: ""
    };
}

describe("DefaultPlatformDetector", function () {
    const detector = new DefaultPlatformDetector();

    describe("detectTarget", function () {
        it("detects windows from user agent", function () {
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

        it("falls back to linux when user agent is empty", function () {
            const target = detector.detectTarget("");
            expect(target.os).toBe("linux");
            expect(target.arch).toBe("x64");
        });

        it("uses platform hint when provided", function () {
            const target = detector.detectTarget("", "win_arm64");
            expect(target.os).toBe("windows");
            expect(target.arch).toBe("arm64");
        });
    });

    describe("selectAsset", function () {
        it("selects windows exe by extension alone", function () {
            const assets = [asset("myapp_x64-setup.exe"), asset("myapp_x64.dmg"), asset("myapp_amd64.deb")];
            const target: Target = { os: "windows", arch: "x64" };
            const selected = detector.selectAsset(assets, target);
            expect(selected === undefined ? "" : selected.name).toBe("myapp_x64-setup.exe");
        });

        it("selects darwin dmg by extension alone", function () {
            const assets = [asset("myapp.exe"), asset("myapp_aarch64.dmg"), asset("myapp.deb")];
            const target: Target = { os: "darwin", arch: "arm64" };
            const selected = detector.selectAsset(assets, target);
            expect(selected === undefined ? "" : selected.name).toBe("myapp_aarch64.dmg");
        });

        it("selects linux deb by extension alone", function () {
            const assets = [asset("myapp.exe"), asset("myapp.dmg"), asset("myapp_amd64.deb")];
            const target: Target = { os: "linux", arch: "x64" };
            const selected = detector.selectAsset(assets, target);
            expect(selected === undefined ? "" : selected.name).toBe("myapp_amd64.deb");
        });

        it("prefers matching arch", function () {
            const assets = [asset("myapp_x64-setup.exe"), asset("myapp_arm64-setup.exe")];
            const target: Target = { os: "windows", arch: "arm64" };
            const selected = detector.selectAsset(assets, target);
            expect(selected === undefined ? "" : selected.name).toBe("myapp_arm64-setup.exe");
        });

        it("prefers name containing windows keyword over generic exe", function () {
            const assets = [asset("app.exe"), asset("app-windows-x64.exe")];
            const target: Target = { os: "windows", arch: "x64" };
            const selected = detector.selectAsset(assets, target);
            expect(selected === undefined ? "" : selected.name).toBe("app-windows-x64.exe");
        });

        it("returns undefined when no asset matches", function () {
            const assets = [asset("app.dmg"), asset("app.deb")];
            const target: Target = { os: "windows", arch: "x64" };
            const selected = detector.selectAsset(assets, target);
            expect(selected).toBeUndefined();
        });
    });
});
