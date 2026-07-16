export interface QueryParams {
    app: string | null;
    version: string | null;
    search: string | null;
}

export function parseQueryParams(): QueryParams {
    const params = new URLSearchParams(window.location.search);
    const result: QueryParams = {
        app: params.get("app"),
        version: params.get("version"),
        search: params.get("search")
    };
    return result;
}

export function updateQueryParams(appName: string | null, version: string | null, search: string | null): void {
    const url = new URL(window.location.href);
    if (appName !== null && appName.length > 0) {
        url.searchParams.set("app", appName);
    } else {
        url.searchParams.delete("app");
    }
    if (version !== null && version.length > 0) {
        url.searchParams.set("version", version);
    } else {
        url.searchParams.delete("version");
    }
    if (search !== null && search.length > 0) {
        url.searchParams.set("search", search);
    } else {
        url.searchParams.delete("search");
    }
    window.history.replaceState({}, "", url.toString());
}
