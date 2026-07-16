import { describe, it, expect } from "vitest";
import * as schemas from "../../src/shared/schemas.js";

function validGitHubAsset(): Record<string, unknown> {
    return {
        name: "app.exe",
        size: 1024,
        content_type: "application/octet-stream",
        url: "https://api.github.com/assets/1",
        browser_download_url: "https://github.com/owner/repo/releases/download/v1.0.0/app.exe"
    };
}

function validGitHubRelease(): Record<string, unknown> {
    return {
        tag_name: "v1.0.0",
        name: "Release 1.0.0",
        body: "Notes",
        published_at: "2024-01-01T00:00:00Z",
        prerelease: false,
        assets: [validGitHubAsset()]
    };
}

describe("AppSchema", function () {
    it("validates a correct app", function () {
        const input = { id: "app1", repo: "owner/repo", name: "App One" };
        const result = schemas.AppSchema.safeParse(input);
        expect(result.success).toBe(true);
    });

    it("rejects an empty id", function () {
        const input = { id: "", repo: "owner/repo", name: "App One" };
        const result = schemas.AppSchema.safeParse(input);
        expect(result.success).toBe(false);
    });

    it("rejects a missing repo", function () {
        const input = { id: "app1", name: "App One" };
        const result = schemas.AppSchema.safeParse(input);
        expect(result.success).toBe(false);
    });
});

describe("PlatformSchema", function () {
    it("accepts windows", function () {
        const result = schemas.PlatformSchema.safeParse("windows");
        expect(result.success).toBe(true);
    });

    it("rejects unknown platform", function () {
        const result = schemas.PlatformSchema.safeParse("freebsd");
        expect(result.success).toBe(false);
    });
});

describe("GitHubAssetSchema", function () {
    it("validates a correct asset", function () {
        const result = schemas.GitHubAssetSchema.safeParse(validGitHubAsset());
        expect(result.success).toBe(true);
    });

    it("rejects negative size", function () {
        const input = validGitHubAsset();
        input["size"] = -1;
        const result = schemas.GitHubAssetSchema.safeParse(input);
        expect(result.success).toBe(false);
    });

    it("rejects invalid url", function () {
        const input = validGitHubAsset();
        input["url"] = "not-a-url";
        const result = schemas.GitHubAssetSchema.safeParse(input);
        expect(result.success).toBe(false);
    });
});

describe("GitHubReleaseSchema", function () {
    it("validates a correct release", function () {
        const result = schemas.GitHubReleaseSchema.safeParse(validGitHubRelease());
        expect(result.success).toBe(true);
    });

    it("releases missing required tag_name", function () {
        const input = validGitHubRelease();
        delete input["tag_name"];
        const result = schemas.GitHubReleaseSchema.safeParse(input);
        expect(result.success).toBe(false);
    });

    it("accepts null body", function () {
        const input = validGitHubRelease();
        input["body"] = null;
        const result = schemas.GitHubReleaseSchema.safeParse(input);
        expect(result.success).toBe(true);
    });
});

describe("DownloadQuerySchema", function () {
    it("validates empty query", function () {
        const result = schemas.DownloadQuerySchema.safeParse({});
        expect(result.success).toBe(true);
    });

    it("validates full query", function () {
        const input = { version: "v1.0.0", asset: "app.exe", platform: "windows_x64" };
        const result = schemas.DownloadQuerySchema.safeParse(input);
        expect(result.success).toBe(true);
    });
});

describe("TauriUpdateQuerySchema", function () {
    it("requires target", function () {
        const result = schemas.TauriUpdateQuerySchema.safeParse({});
        expect(result.success).toBe(false);
    });

    it("accepts target and current_version", function () {
        const input = { target: "windows-x86_64", current_version: "v1.0.0" };
        const result = schemas.TauriUpdateQuerySchema.safeParse(input);
        expect(result.success).toBe(true);
    });
});
