import * as types from "../../shared/types.js";

export interface GitHubProvider {
    listReleases(repo: string, options?: ListReleasesOptions): Promise<FetchResult<types.GitHubRelease[]>>;
    getReleaseByTag(repo: string, tag: string): Promise<FetchResult<types.GitHubRelease>>;
}

export interface ListReleasesOptions {
    page?: number;
    perPage?: number;
    etag?: string;
}

export interface FetchResult<T> {
    data: T;
    etag: string | undefined;
    fromCache: boolean;
}

export interface CircuitBreakerState {
    failures: number;
    lastFailureTime: number;
    state: "closed" | "open" | "half-open";
}

export interface InFlightRequest<T> {
    promise: Promise<T>;
    expiry: number;
}
