import * as uaParser from "ua-parser-js";
import * as types from "../../shared/types.js";

export interface PlatformDetector {
    detectTarget(userAgent?: string, platformHint?: string): types.Target;
    selectAsset(assets: types.Asset[], target: types.Target): types.Asset | undefined;
    normalizeOs(os: string): types.Platform | undefined;
    normalizeArch(arch: string): string | undefined;
}

export class DefaultPlatformDetector implements PlatformDetector {
    detectTarget(userAgent?: string, platformHint?: string): types.Target {
        if (platformHint !== undefined && platformHint.length > 0) {
            return this.parsePlatformHint(platformHint);
        }
        if (userAgent !== undefined && userAgent.length > 0) {
            const parser = new uaParser.UAParser(userAgent);
            const osResult = parser.getOS();
            const cpuResult = parser.getCPU();
            const os = this.normalizeOs(osResult.name || "");
            const arch = this.normalizeArch(cpuResult.architecture || "");
            if (os !== undefined) {
                return { os: os, arch: arch || "x64" };
            }
        }
        return { os: "linux", arch: "x64" };
    }

    selectAsset(assets: types.Asset[], target: types.Target): types.Asset | undefined {
        let best: types.Asset | undefined;
        let bestScore = 0;
        for (let i = 0; i < assets.length; i = i + 1) {
            const asset = assets[i];
            const score = this.scoreAsset(asset, target);
            if (score > bestScore) {
                bestScore = score;
                best = asset;
            }
        }
        return best;
    }

    normalizeOs(os: string): types.Platform | undefined {
        const lower = os.toLowerCase();
        if (lower.indexOf("windows") >= 0 || lower.indexOf("win32") >= 0) {
            return "windows";
        }
        if (lower.indexOf("mac") >= 0 || lower.indexOf("darwin") >= 0 || lower.indexOf("osx") >= 0) {
            return "darwin";
        }
        if (lower.indexOf("linux") >= 0) {
            return "linux";
        }
        return undefined;
    }

    normalizeArch(arch: string): string | undefined {
        const lower = arch.toLowerCase();
        if (lower.indexOf("arm64") >= 0 || lower.indexOf("aarch64") >= 0) {
            return "arm64";
        }
        if (lower.indexOf("x86_64") >= 0 || lower.indexOf("amd64") >= 0 || lower.indexOf("x64") >= 0) {
            return "x64";
        }
        if (
            lower.indexOf("x86") >= 0 ||
            lower.indexOf("i386") >= 0 ||
            lower.indexOf("i686") >= 0 ||
            lower.indexOf("32") >= 0
        ) {
            return "x86";
        }
        return undefined;
    }

    private parsePlatformHint(hint: string): types.Target {
        const parts = hint.split("_");
        const first = parts[0].toLowerCase();
        let os: types.Platform | undefined;
        if (first === "windows" || first === "win") {
            os = "windows";
        } else if (first === "darwin" || first === "macos" || first === "mac") {
            os = "darwin";
        } else if (first === "linux") {
            os = "linux";
        }
        let arch: string | undefined;
        if (parts.length > 1) {
            arch = this.normalizeArch(parts[1]);
        }
        if (os === undefined) {
            return { os: "linux", arch: arch || "x64" };
        }
        return { os: os, arch: arch || "x64" };
    }

    private scoreAsset(asset: types.Asset, target: types.Target): number {
        const name = asset.name.toLowerCase();
        let score = 0;
        const inferredOs = this.inferOsFromExtension(name);
        const osScore = this.scoreOs(name, target.os, inferredOs);
        if (osScore <= 0) {
            return 0;
        }
        score = score + osScore;
        const extScore = this.scoreExtension(name, target.os);
        if (target.os === "linux" && extScore <= 0) {
            return 0;
        }
        score = score + extScore;
        const archScore = this.scoreArch(name, target.arch);
        score = score + archScore;
        if (target.os === "darwin" && name.indexOf("universal") >= 0) {
            score = score + 25;
        }
        return score;
    }

    private inferOsFromExtension(name: string): types.Platform | undefined {
        if (name.endsWith(".exe") || name.endsWith(".msi")) {
            return "windows";
        }
        if (name.endsWith(".dmg") || name.endsWith(".pkg")) {
            return "darwin";
        }
        if (name.endsWith(".deb") || name.endsWith(".rpm") || name.endsWith(".appimage")) {
            return "linux";
        }
        return undefined;
    }

    private scoreOs(name: string, os: types.Platform, inferredOs?: types.Platform): number {
        if (inferredOs === os) {
            return 20;
        }
        if (os === "windows") {
            if (name.indexOf("windows") >= 0 || name.indexOf("win") >= 0) {
                return 20;
            }
        }
        if (os === "darwin") {
            if (
                name.indexOf("darwin") >= 0 ||
                name.indexOf("macos") >= 0 ||
                name.indexOf("mac") >= 0 ||
                name.indexOf("osx") >= 0
            ) {
                return 20;
            }
        }
        if (os === "linux") {
            if (
                name.indexOf("linux") >= 0 ||
                name.indexOf("appimage") >= 0 ||
                name.indexOf("deb") >= 0 ||
                name.indexOf("rpm") >= 0
            ) {
                return 20;
            }
        }
        return 0;
    }

    private scoreExtension(name: string, os: types.Platform): number {
        if (os === "windows") {
            if (name.indexOf(".exe") >= 0 || name.indexOf(".msi") >= 0 || name.indexOf(".zip") >= 0) {
                return 10;
            }
        }
        if (os === "darwin") {
            if (name.indexOf(".dmg") >= 0 || name.indexOf(".app.tar.gz") >= 0 || name.indexOf(".app") >= 0) {
                return 10;
            }
        }
        if (os === "linux") {
            if (
                name.indexOf(".appimage") >= 0 ||
                name.indexOf(".deb") >= 0 ||
                name.indexOf(".rpm") >= 0 ||
                name.indexOf(".tar.gz") >= 0
            ) {
                return 10;
            }
        }
        return 0;
    }

    private scoreArch(name: string, arch: string): number {
        if (arch === "arm64") {
            if (name.indexOf("arm64") >= 0 || name.indexOf("aarch64") >= 0) {
                return 15;
            }
            if (name.indexOf("x64") >= 0 || name.indexOf("x86_64") >= 0 || name.indexOf("amd64") >= 0) {
                return 5;
            }
        }
        if (arch === "x64") {
            if (name.indexOf("x64") >= 0 || name.indexOf("x86_64") >= 0 || name.indexOf("amd64") >= 0) {
                return 15;
            }
            if (name.indexOf("arm64") >= 0 || name.indexOf("aarch64") >= 0) {
                return 0;
            }
        }
        if (arch === "x86") {
            if (
                name.indexOf("x86") >= 0 ||
                name.indexOf("i386") >= 0 ||
                name.indexOf("i686") >= 0 ||
                name.indexOf("32") >= 0
            ) {
                return 15;
            }
        }
        return 0;
    }
}
