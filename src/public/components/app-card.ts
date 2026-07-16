import type { Store, AppState, GlobalState } from "../state.js";
import type { PublicRelease } from "../api-client.js";
import type { ReleaseNotesModal } from "./release-notes-modal.js";
import { createLoadingSkeleton } from "./loading-skeleton.js";
import { createErrorBoundary } from "./error-boundary.js";
import { getPlatformLabel } from "../platform-label.js";
import {
    fetchReleases,
    fetchUpdate,
    buildSmartDownloadUrl,
    buildDownloadUrl,
    buildApiReleasesUrl,
    buildApiUpdateUrl,
    buildInstallCommand
} from "../api-client.js";
import { copyToClipboard } from "../clipboard.js";
import { formatFileSize, formatDate, formatRelativeDate } from "../format-utils.js";
import { updateQueryParams } from "../query-params.js";

export interface AppCard {
    element: HTMLElement;
    load(): Promise<void>;
    selectVersion(version: string): Promise<void>;
}

function findAppState(state: GlobalState, appName: string): AppState | null {
    for (let i = 0; i < state.apps.length; i = i + 1) {
        if (state.apps[i].appName === appName) {
            return state.apps[i];
        }
    }
    return null;
}

export function createAppCard(store: Store, modal: ReleaseNotesModal, appName: string, displayName: string): AppCard {
    const card = document.createElement("article");
    card.className = "app-card";
    card.setAttribute("data-app", appName);
    card.setAttribute("tabindex", "-1");

    const heading = document.createElement("h2");
    heading.textContent = displayName;
    card.appendChild(heading);

    const content = document.createElement("div");
    content.className = "app-card__content";
    card.appendChild(content);

    store.registerApp(appName, displayName);

    async function loadReleases(): Promise<void> {
        store.setLoading(appName);
        try {
            const releases = await fetchReleases(appName);
            store.setReleases(appName, releases);
            const state = store.getState();
            const appState = findAppState(state, appName);
            if (appState !== null && appState.selectedVersion.length > 0) {
                await loadUpdate(appState.selectedVersion);
            }
        } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            store.setError(appName, message);
        }
    }

    async function loadUpdate(version: string): Promise<void> {
        store.setLoading(appName);
        try {
            const update = await fetchUpdate(appName, version);
            store.setUpdate(appName, update);
        } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            store.setError(appName, message);
        }
    }

    async function selectVersion(version: string): Promise<void> {
        store.selectVersion(appName, version);
        await loadUpdate(version);
        updateQueryParams(appName, version, store.getState().filter);
    }

    function onVersionChange(event: Event): void {
        const target = event.target as HTMLSelectElement;
        const version = target.value;
        void selectVersion(version);
    }

    function onRetry(): void {
        void loadReleases();
    }

    function onCopy(text: string, button: HTMLButtonElement): void {
        void copyToClipboard(text).then(function onCopied(success: boolean): void {
            const original = button.textContent || "";
            button.textContent = success ? "Copied!" : "Copy failed";
            window.setTimeout(function restoreLabel(): void {
                button.textContent = original;
            }, 1500);
        });
    }

    function render(): void {
        const state = store.getState();
        const appState = findAppState(state, appName);
        if (appState === null) {
            return;
        }
        content.innerHTML = "";
        if (appState.status === "loading" && appState.releases.length === 0) {
            content.appendChild(createLoadingSkeleton());
            return;
        }
        if (appState.status === "error") {
            content.appendChild(
                createErrorBoundary({
                    message: appState.errorMessage,
                    onRetry: onRetry
                })
            );
            return;
        }
        if (appState.releases.length === 0) {
            const empty = document.createElement("p");
            empty.textContent = "No releases available.";
            content.appendChild(empty);
            return;
        }
        content.appendChild(createVersionSelector(appState.releases, appState.selectedVersion));
        content.appendChild(createActionButtons(appState));
        content.appendChild(createMetaPanel(appState));
        content.appendChild(createCopyPanel(appState));
        content.appendChild(createFilteredList(appState, state.filter));
    }

    function createVersionSelector(releases: PublicRelease[], selectedVersion: string): HTMLElement {
        const wrapper = document.createElement("div");
        wrapper.className = "version-selector";

        const label = document.createElement("label");
        label.htmlFor = "version-select-" + appName;
        label.textContent = "Version";
        wrapper.appendChild(label);

        const select = document.createElement("select");
        select.id = "version-select-" + appName;
        for (let i = 0; i < releases.length; i = i + 1) {
            const release = releases[i];
            const option = document.createElement("option");
            option.value = release.tag;
            option.textContent = release.tag + " (" + formatRelativeDate(release.publishedAt) + ")";
            if (release.tag === selectedVersion) {
                option.selected = true;
            }
            select.appendChild(option);
        }
        select.addEventListener("change", onVersionChange);
        wrapper.appendChild(select);
        return wrapper;
    }

    function createActionButtons(appState: AppState): HTMLElement {
        const group = document.createElement("div");
        group.className = "button-group";

        const smart = document.createElement("a");
        smart.className = "btn btn-primary";
        smart.href = buildSmartDownloadUrl(appState.appName, appState.selectedVersion);
        smart.textContent = "Smart Download";
        group.appendChild(smart);

        const update = appState.updateData;
        if (update !== null) {
            for (let i = 0; i < update.assets.length; i = i + 1) {
                const asset = update.assets[i];
                const link = document.createElement("a");
                link.className = "btn btn-platform";
                link.href = buildDownloadUrl(appState.appName, update.version, asset.name);
                link.textContent = getPlatformLabel(asset.name);
                group.appendChild(link);
            }
        }
        return group;
    }

    function createMetaPanel(appState: AppState): HTMLElement {
        const panel = document.createElement("div");
        panel.className = "meta-panel";

        const version = document.createElement("div");
        version.className = "meta-item";
        version.textContent = "Version: " + appState.selectedVersion;
        panel.appendChild(version);

        const update = appState.updateData;
        if (update !== null) {
            const date = document.createElement("div");
            date.className = "meta-item";
            date.textContent =
                "Published: " + formatDate(update.publishedAt) + " (" + formatRelativeDate(update.publishedAt) + ")";
            panel.appendChild(date);

            for (let i = 0; i < update.assets.length; i = i + 1) {
                const asset = update.assets[i];
                const assetMeta = document.createElement("div");
                assetMeta.className = "meta-item meta-item--asset";
                assetMeta.textContent = asset.name + " - " + formatFileSize(asset.size) + " - SHA-256: not available";
                panel.appendChild(assetMeta);
            }
        }
        return panel;
    }

    function createCopyPanel(appState: AppState): HTMLElement {
        const panel = document.createElement("div");
        panel.className = "copy-panel";

        const releaseUrl = buildApiReleasesUrl(appState.appName);
        panel.appendChild(createCopyButton("Copy releases API URL", releaseUrl));

        const updateUrl = buildApiUpdateUrl(appState.appName);
        panel.appendChild(createCopyButton("Copy update API URL", updateUrl));

        const update = appState.updateData;
        if (update !== null && update.assets.length > 0) {
            const command = buildInstallCommand(appState.appName, update.version, update.assets[0].name);
            panel.appendChild(createCopyButton("Copy install command", command));
        }

        return panel;
    }

    function createCopyButton(label: string, text: string): HTMLButtonElement {
        const button = document.createElement("button");
        button.type = "button";
        button.className = "btn btn-copy";
        button.textContent = label;
        button.addEventListener("click", function onCopyClick(): void {
            onCopy(text, button);
        });
        return button;
    }

    function createFilteredList(appState: AppState, filter: string): HTMLElement {
        const section = document.createElement("div");
        section.className = "release-list-section";

        const title = document.createElement("h3");
        title.className = "release-list-title";
        title.textContent = "Releases";
        section.appendChild(title);

        const list = document.createElement("ul");
        list.className = "release-list";
        const lowerFilter = filter.toLowerCase();
        let count = 0;
        for (let i = 0; i < appState.releases.length; i = i + 1) {
            const release = appState.releases[i];
            if (filter.length > 0) {
                const haystack = (release.tag + " " + release.name + " " + release.notes).toLowerCase();
                if (haystack.indexOf(lowerFilter) < 0) {
                    continue;
                }
            }
            count = count + 1;
            list.appendChild(createReleaseItem(release));
        }
        if (count === 0) {
            const empty = document.createElement("li");
            empty.className = "release-list-empty";
            empty.textContent = "No releases match your filter.";
            list.appendChild(empty);
        }
        section.appendChild(list);
        return section;
    }

    function createReleaseItem(release: PublicRelease): HTMLElement {
        const item = document.createElement("li");
        item.className = "release-list-item";

        const info = document.createElement("span");
        info.className = "release-list-item__info";
        info.textContent = release.tag + " - " + formatRelativeDate(release.publishedAt);
        item.appendChild(info);

        const notesButton = document.createElement("button");
        notesButton.type = "button";
        notesButton.className = "btn btn-small";
        notesButton.textContent = "Notes";
        notesButton.addEventListener("click", function onNotesClick(): void {
            void modal.open(release);
        });
        item.appendChild(notesButton);

        return item;
    }

    card.addEventListener("focusin", function onFocusIn(): void {
        store.setSelectedApp(appName);
    });

    store.subscribe(function onStoreChange(): void {
        render();
    });

    render();
    void loadReleases();

    const appCard: AppCard = {
        element: card,
        load: loadReleases,
        selectVersion: selectVersion
    };
    return appCard;
}
