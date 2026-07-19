export type Platform = "windows" | "darwin" | "linux";

export interface App {
    id: string;
    repo: string;
    name: string;
}

export interface Asset {
    name: string;
    size: number;
    contentType: string;
    url: string;
    browserDownloadUrl: string;
    checksum?: string;
}

export interface Release {
    tag: string;
    name: string;
    notes: string;
    publishedAt: string;
    prerelease: boolean;
    assets: Asset[];
}

export interface Target {
    os: Platform;
    arch: string;
}

export interface UpdateManifest {
    version: string;
    notes: string;
    pubDate: string;
    platforms: Record<string, { signature: string; url: string }>;
}

export interface GitHubAsset {
    name: string;
    size: number;
    content_type: string;
    url: string;
    browser_download_url: string;
}

export interface GitHubRelease {
    tag_name: string;
    name: string;
    body: string | null;
    published_at: string;
    prerelease: boolean;
    assets: GitHubAsset[];
}
