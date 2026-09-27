import { createStore, type GlobalState, type AppState, type Store } from "./state.js";
import { createReleaseNotesModal } from "./components/release-notes-modal.js";
import { createAppCard, type AppCard } from "./components/app-card.js";
import { parseQueryParams, updateQueryParams } from "./query-params.js";
import { fetchApps, type ConfiguredApp } from "./api-client.js";
import "./styles.css";

function findAppState(state: GlobalState, appName: string): AppState | null {
    for (let i = 0; i < state.apps.length; i = i + 1) {
        if (state.apps[i].appName === appName) {
            return state.apps[i];
        }
    }
    return null;
}

function getSelectedVersion(store: Store): string | null {
    const state = store.getState();
    const appName = state.selectedAppName;
    if (appName === null) {
        return null;
    }
    const appState = findAppState(state, appName);
    if (appState === null) {
        return null;
    }
    return appState.selectedVersion;
}

function setupOfflineBanner(): void {
    const banner = document.getElementById("offline-banner");
    function updateBanner(): void {
        if (banner === null) {
            return;
        }
        if (navigator.onLine) {
            banner.classList.add("is-hidden");
            banner.classList.remove("is-visible");
        } else {
            banner.classList.add("is-visible");
            banner.classList.remove("is-hidden");
        }
    }
    window.addEventListener("online", updateBanner);
    window.addEventListener("offline", updateBanner);
    updateBanner();
}

/**
 * Renders the per-app update API links.
 *
 * Built from the app list the server reports, never from a copy kept in the markup. That way
 * adding an app on the server needs no frontend change and no rebuild, and there is only ever
 * one list in the system.
 *
 * Text is inserted as text content, so a display name is never parsed as markup.
 */
export function renderApiNote(container: HTMLElement, apps: ConfiguredApp[]): void {
    const note = document.createElement("div");
    note.className = "api-note";
    const label = document.createElement("span");
    label.textContent = "Update API: ";
    note.appendChild(label);
    for (let i = 0; i < apps.length; i = i + 1) {
        if (i > 0) {
            const separator = document.createElement("span");
            separator.textContent = i === apps.length - 1 ? " and " : ", ";
            note.appendChild(separator);
        }
        const code = document.createElement("code");
        code.textContent = "/api/update/" + apps[i].id;
        note.appendChild(code);
    }
    container.appendChild(note);
}

function reportAppListFailure(container: HTMLElement, err: unknown): void {
    const note = document.createElement("div");
    note.className = "api-note";
    note.textContent = "The app list could not be loaded. Refresh to try again, or check the server is running.";
    container.appendChild(note);
    // Worth logging: the visible message tells the user what to do, but only this says why it
    // failed, which is what makes the report actionable. Handed the raw value, not a string, so
    // an Error keeps its stack.
    console.error(err);
}

function init(): void {
    const store = createStore();
    const modal = createReleaseNotesModal();

    const container = document.querySelector<HTMLElement>(".container");
    if (container === null) {
        return;
    }

    const searchInput = document.getElementById("release-search") as HTMLInputElement | null;
    if (searchInput !== null) {
        searchInput.addEventListener("input", function onSearchInput(): void {
            store.setFilter(searchInput.value);
            updateQueryParams(store.getState().selectedAppName, getSelectedVersion(store), searchInput.value);
        });
    }

    const appGrid = document.getElementById("app-grid");
    if (appGrid === null) {
        return;
    }

    const cards: AppCard[] = [];
    // The server is the only source of the app list. Fetching it means the page always shows
    // exactly what the mirror actually serves, with no second copy to keep in step.
    void fetchApps()
        .then(function onApps(apps: ConfiguredApp[]): void {
            for (let i = 0; i < apps.length; i = i + 1) {
                const app = apps[i];
                const card = createAppCard(store, modal, app.id, app.name);
                appGrid.appendChild(card.element);
                cards.push(card);
            }
            renderApiNote(container, apps);
            applyQueryParams(store, searchInput, cards);
        })
        .catch(function onFailed(err: unknown): void {
            reportAppListFailure(container, err);
        });

    setupOfflineBanner();
}

function applyQueryParams(store: Store, searchInput: HTMLInputElement | null, cards: AppCard[]): void {
    const params = parseQueryParams();
    if (params.search !== null && params.search.length > 0 && searchInput !== null) {
        searchInput.value = params.search;
        store.setFilter(params.search);
    }
    if (params.app !== null && params.app.length > 0) {
        store.setSelectedApp(params.app);
    }
    for (let i = 0; i < cards.length; i += 1) {
        const card = cards[i];
        void card.load().then(function afterLoad(): void {
            if (
                params.app === card.element.getAttribute("data-app") &&
                params.version !== null &&
                params.version.length > 0
            ) {
                void card.selectVersion(params.version);
            }
        });
    }
}

if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
} else {
    init();
}
