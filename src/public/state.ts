import type { PublicRelease, UpdateResponse } from "./api-client.js";

export interface AppState {
    appName: string;
    displayName: string;
    releases: PublicRelease[];
    selectedVersion: string;
    updateData: UpdateResponse | null;
    status: "idle" | "loading" | "error";
    errorMessage: string;
}

export interface GlobalState {
    apps: AppState[];
    filter: string;
    selectedAppName: string | null;
}

export type Listener = () => void;

export interface Store {
    getState(): GlobalState;
    registerApp(appName: string, displayName: string): void;
    setReleases(appName: string, releases: PublicRelease[]): void;
    selectVersion(appName: string, version: string): void;
    setUpdate(appName: string, update: UpdateResponse): void;
    setLoading(appName: string): void;
    setError(appName: string, message: string): void;
    setFilter(filter: string): void;
    setSelectedApp(appName: string): void;
    subscribe(listener: Listener): () => void;
}

export function createStore(): Store {
    const state: GlobalState = {
        apps: [],
        filter: "",
        selectedAppName: null
    };
    const listeners: Listener[] = [];

    function notify(): void {
        for (let i = 0; i < listeners.length; i = i + 1) {
            listeners[i]();
        }
    }

    function findApp(appName: string): AppState | null {
        for (let i = 0; i < state.apps.length; i = i + 1) {
            if (state.apps[i].appName === appName) {
                return state.apps[i];
            }
        }
        return null;
    }

    function getState(): GlobalState {
        return state;
    }

    function registerApp(appName: string, displayName: string): void {
        const existing = findApp(appName);
        if (existing !== null) {
            return;
        }
        const appState: AppState = {
            appName: appName,
            displayName: displayName,
            releases: [],
            selectedVersion: "",
            updateData: null,
            status: "idle",
            errorMessage: ""
        };
        state.apps.push(appState);
        notify();
    }

    function setReleases(appName: string, releases: PublicRelease[]): void {
        const app = findApp(appName);
        if (app === null) {
            return;
        }
        app.releases = releases;
        if (releases.length > 0 && app.selectedVersion === "") {
            app.selectedVersion = releases[0].tag;
        }
        notify();
    }

    function selectVersion(appName: string, version: string): void {
        const app = findApp(appName);
        if (app === null) {
            return;
        }
        app.selectedVersion = version;
        notify();
    }

    function setUpdate(appName: string, update: UpdateResponse): void {
        const app = findApp(appName);
        if (app === null) {
            return;
        }
        app.updateData = update;
        app.status = "idle";
        app.errorMessage = "";
        notify();
    }

    function setLoading(appName: string): void {
        const app = findApp(appName);
        if (app === null) {
            return;
        }
        app.status = "loading";
        app.errorMessage = "";
        notify();
    }

    function setError(appName: string, message: string): void {
        const app = findApp(appName);
        if (app === null) {
            return;
        }
        app.status = "error";
        app.errorMessage = message;
        notify();
    }

    function setFilter(filter: string): void {
        state.filter = filter;
        notify();
    }

    function setSelectedApp(appName: string): void {
        state.selectedAppName = appName;
        notify();
    }

    function subscribe(listener: Listener): () => void {
        listeners.push(listener);
        return function unsubscribe(): void {
            for (let i = 0; i < listeners.length; i = i + 1) {
                if (listeners[i] === listener) {
                    listeners.splice(i, 1);
                    return;
                }
            }
        };
    }

    const store: Store = {
        getState: getState,
        registerApp: registerApp,
        setReleases: setReleases,
        selectVersion: selectVersion,
        setUpdate: setUpdate,
        setLoading: setLoading,
        setError: setError,
        setFilter: setFilter,
        setSelectedApp: setSelectedApp,
        subscribe: subscribe
    };
    return store;
}
