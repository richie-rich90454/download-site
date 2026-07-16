import { createStore, type GlobalState, type AppState, type Store } from "./state.js";
import { createReleaseNotesModal } from "./components/release-notes-modal.js";
import { createAppCard, type AppCard } from "./components/app-card.js";
import { parseQueryParams, updateQueryParams } from "./query-params.js";
import "./styles/main.css";

interface AppConfig {
    id: string;
    name: string;
    displayName: string;
}

const APP_CONFIG: AppConfig[] = [
    { id: "app1", name: "randmatqugea", displayName: "RandMatQuGeA" },
    { id: "app2", name: "desktopcalendartracking", displayName: "Desktop Calendar Tracking" }
];

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

function init(): void {
    const store = createStore();
    const modal = createReleaseNotesModal();

    const container = document.querySelector(".container");
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
    for (let i = 0; i < APP_CONFIG.length; i = i + 1) {
        const config = APP_CONFIG[i];
        const card = createAppCard(store, modal, config.name, config.displayName);
        appGrid.appendChild(card.element);
        cards.push(card);
    }

    setupOfflineBanner();

    const params = parseQueryParams();
    if (params.search !== null && params.search.length > 0 && searchInput !== null) {
        searchInput.value = params.search;
        store.setFilter(params.search);
    }
    if (params.app !== null && params.app.length > 0) {
        store.setSelectedApp(params.app);
    }

    for (let i = 0; i < cards.length; i = i + 1) {
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
