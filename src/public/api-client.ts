export interface PublicAsset {
    name: string;
    size: number;
    contentType: string;
    url: string;
    browserDownloadUrl: string;
}

export interface PublicRelease {
    tag: string;
    name: string;
    notes: string;
    publishedAt: string;
    prerelease: boolean;
    assets: PublicAsset[];
}

export interface ReleasesResponse {
    app: string;
    page: number;
    perPage: number;
    total: number;
    releases: PublicRelease[];
}

export interface UpdateResponse {
    version: string;
    publishedAt: string;
    releaseNotes: string;
    assets: PublicAsset[];
}

export async function fetchReleases(appName: string): Promise<PublicRelease[]> {
    const url = "/api/releases/" + encodeURIComponent(appName) + "?per_page=100";
    const response = await fetch(url);
    if (!response.ok) {
        throw new Error("Failed to fetch releases: " + response.statusText);
    }
    const data = (await response.json()) as ReleasesResponse;
    if (data.releases === undefined || data.releases === null) {
        return [];
    }
    return data.releases;
}

export async function fetchUpdate(appName: string, version: string): Promise<UpdateResponse> {
    const url = "/api/update/" + encodeURIComponent(appName) + "?version=" + encodeURIComponent(version);
    const response = await fetch(url);
    if (!response.ok) {
        throw new Error("Failed to fetch update: " + response.statusText);
    }
    return response.json() as Promise<UpdateResponse>;
}

export async function fetchDownload(appName: string, version: string, assetName: string): Promise<Blob> {
    const url =
        "/download/" +
        encodeURIComponent(appName) +
        "?version=" +
        encodeURIComponent(version) +
        "&asset=" +
        encodeURIComponent(assetName);
    const response = await fetch(url);
    if (!response.ok) {
        throw new Error("Download failed: " + response.statusText);
    }
    return response.blob();
}

export function buildApiReleasesUrl(appName: string): string {
    return window.location.origin + "/api/releases/" + encodeURIComponent(appName);
}

export function buildApiUpdateUrl(appName: string): string {
    return window.location.origin + "/api/update/" + encodeURIComponent(appName);
}

export function buildDownloadUrl(appName: string, version: string, assetName: string): string {
    return (
        window.location.origin +
        "/download/" +
        encodeURIComponent(appName) +
        "?version=" +
        encodeURIComponent(version) +
        "&asset=" +
        encodeURIComponent(assetName)
    );
}

export function buildSmartDownloadUrl(appName: string, version: string): string {
    return (
        window.location.origin + "/download/" + encodeURIComponent(appName) + "?version=" + encodeURIComponent(version)
    );
}

export function buildInstallCommand(appName: string, version: string, assetName: string): string {
    return "curl -fsSL " + buildDownloadUrl(appName, version, assetName) + " -o " + assetName;
}
