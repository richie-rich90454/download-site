import type { Store, AppState, GlobalState } from "../state.js";
import type { PublicRelease, PublicAsset } from "../api-client.js";
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

    let lastSnapshot = "";

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

    function onCopy(text: string, button: Element): void {
        void copyToClipboard(text).then(function onCopied(success: boolean): void {
            const original = button.textContent || "";
            button.textContent = success ? "Copied!" : "Copy failed";
            window.setTimeout(function restoreLabel(): void {
                button.textContent = original;
            }, 1500);
        });
    }

    function onMetaPanelClick(event: MouseEvent): void {
        const target = event.target as HTMLElement;
        const button = target.closest(".btn-copy");
        if (button === null) {
            return;
        }
        const checksum = button.getAttribute("data-checksum");
        if (checksum === null) {
            return;
        }
        onCopy(checksum, button);
    }

    function onCopyPanelClick(event: MouseEvent): void {
        const target = event.target as HTMLElement;
        const button = target.closest(".btn-copy");
        if (button === null) {
            return;
        }
        const text = button.getAttribute("data-copy-text");
        if (text === null) {
            return;
        }
        onCopy(text, button);
    }

    function onReleaseListClick(event: MouseEvent): void {
        const target = event.target as HTMLElement;
        const button = target.closest(".release-list-item button");
        if (button === null) {
            return;
        }
        const tag = button.getAttribute("data-release-tag");
        if (tag === null) {
            return;
        }
        const state = store.getState();
        const appState = findAppState(state, appName);
        if (appState === null) {
            return;
        }
        for (let i = 0; i < appState.releases.length; i = i + 1) {
            if (appState.releases[i].tag === tag) {
                void modal.open(appState.releases[i]);
                return;
            }
        }
    }

    function render(): void {
        const state = store.getState();
        const appState = findAppState(state, appName);
        if (appState === null) {
            return;
        }
        let view = "content";
        if (appState.status === "loading" && appState.releases.length === 0) {
            view = "skeleton";
        } else if (appState.status === "error") {
            view = "error";
        } else if (appState.releases.length === 0) {
            view = "empty";
        }
        const snapshot = JSON.stringify({
            filter: state.filter,
            view: view,
            releases: appState.releases,
            selectedVersion: appState.selectedVersion,
            updateData: appState.updateData
        });
        if (snapshot === lastSnapshot) {
            return;
        }
        let previousView = "";
        if (lastSnapshot.length > 0) {
            const previous = JSON.parse(lastSnapshot) as { view: string };
            previousView = previous.view;
        }
        lastSnapshot = snapshot;
        if (view !== previousView) {
            content.innerHTML = "";
            if (view === "skeleton") {
                content.appendChild(createLoadingSkeleton());
                return;
            }
            if (view === "error") {
                content.appendChild(
                    createErrorBoundary({
                        message: appState.errorMessage,
                        onRetry: onRetry
                    })
                );
                return;
            }
            if (view === "empty") {
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
            return;
        }
        if (view === "content") {
            const select = content.querySelector("select");
            if (select !== null) {
                updateVersionSelector(select, appState.releases, appState.selectedVersion);
            }
            const actionButtons = content.querySelector(".button-group");
            if (actionButtons !== null) {
                updateActionButtons(actionButtons as HTMLElement, appState);
            }
            const metaPanel = content.querySelector(".meta-panel");
            if (metaPanel !== null) {
                updateMetaPanel(metaPanel as HTMLElement, appState);
            }
            const copyPanel = content.querySelector(".copy-panel");
            if (copyPanel !== null) {
                updateCopyPanel(copyPanel as HTMLElement, appState);
            }
            const releaseListSection = content.querySelector(".release-list-section");
            if (releaseListSection !== null) {
                updateFilteredList(releaseListSection as HTMLElement, appState, state.filter);
            }
        }
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

    function updateVersionSelector(
        select: HTMLSelectElement,
        releases: PublicRelease[],
        selectedVersion: string
    ): void {
        let needsRebuild = select.options.length !== releases.length;
        if (!needsRebuild) {
            for (let i = 0; i < releases.length; i = i + 1) {
                if (select.options[i].value !== releases[i].tag) {
                    needsRebuild = true;
                    break;
                }
            }
        }
        if (needsRebuild) {
            select.innerHTML = "";
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
        }
        if (select.value !== selectedVersion) {
            select.value = selectedVersion;
        }
    }

    function createActionButtons(appState: AppState): HTMLElement {
        const group = document.createElement("div");
        group.className = "button-group";
        updateActionButtons(group, appState);
        return group;
    }

    function updateActionButtons(group: HTMLElement, appState: AppState): void {
        const children = group.children;
        let smart = children[0] as HTMLAnchorElement | undefined;
        if (smart === undefined || smart.tagName !== "A") {
            group.innerHTML = "";
            smart = document.createElement("a");
            smart.className = "btn btn-primary";
            smart.textContent = "Smart Download";
            group.appendChild(smart);
        }
        smart.href = buildSmartDownloadUrl(appState.appName, appState.selectedVersion);

        const update = appState.updateData;
        let index = 1;
        if (update !== null) {
            for (let i = 0; i < update.assets.length; i = i + 1) {
                const asset = update.assets[i];
                let link = children[index] as HTMLAnchorElement | undefined;
                if (link === undefined || link.tagName !== "A") {
                    link = document.createElement("a");
                    link.className = "btn btn-platform";
                    group.appendChild(link);
                }
                link.href = buildDownloadUrl(appState.appName, update.version, asset.name);
                link.textContent = getPlatformLabel(asset.name);
                index = index + 1;
            }
        }
        while (children.length > index) {
            group.removeChild(children[children.length - 1]);
        }
    }

    function createMetaPanel(appState: AppState): HTMLElement {
        const panel = document.createElement("div");
        panel.className = "meta-panel";
        panel.addEventListener("click", onMetaPanelClick);
        updateMetaPanel(panel, appState);
        return panel;
    }

    function updateMetaPanel(panel: HTMLElement, appState: AppState): void {
        const children = panel.children;
        let version = children[0] as HTMLDivElement | undefined;
        if (version === undefined || version.tagName !== "DIV") {
            panel.innerHTML = "";
            version = document.createElement("div");
            version.className = "meta-item";
            panel.appendChild(version);
        }
        version.textContent = "Version: " + appState.selectedVersion;

        const update = appState.updateData;
        let index = 1;
        if (update !== null) {
            let date = children[index] as HTMLDivElement | undefined;
            if (date === undefined || date.tagName !== "DIV" || date.className.indexOf("meta-item--asset") >= 0) {
                date = document.createElement("div");
                date.className = "meta-item";
                panel.insertBefore(date, children[index] || null);
            }
            date.textContent =
                "Published: " + formatDate(update.publishedAt) + " (" + formatRelativeDate(update.publishedAt) + ")";
            index = index + 1;

            for (let i = 0; i < update.assets.length; i = i + 1) {
                const asset = update.assets[i];
                let assetMeta = children[index] as HTMLDivElement | undefined;
                if (
                    assetMeta === undefined ||
                    assetMeta.tagName !== "DIV" ||
                    assetMeta.className.indexOf("meta-item--asset") < 0
                ) {
                    assetMeta = document.createElement("div");
                    assetMeta.className = "meta-item meta-item--asset";
                    panel.insertBefore(assetMeta, children[index] || null);
                }
                updateAssetMeta(assetMeta, asset);
                index = index + 1;
            }
        }
        while (children.length > index) {
            panel.removeChild(children[children.length - 1]);
        }
    }

    function updateAssetMeta(container: HTMLDivElement, asset: PublicAsset): void {
        container.innerHTML = "";
        const info = document.createElement("span");
        info.textContent = asset.name + " - " + formatFileSize(asset.size);
        container.appendChild(info);
        if (asset.checksum !== undefined && asset.checksum.length > 0) {
            const checksumText = document.createElement("span");
            checksumText.textContent = " - SHA-256: " + asset.checksum.substring(0, 16) + "...";
            container.appendChild(checksumText);
            const copyButton = document.createElement("button");
            copyButton.type = "button";
            copyButton.className = "btn btn-small btn-copy";
            copyButton.textContent = "Copy checksum";
            copyButton.setAttribute("data-checksum", asset.checksum);
            container.appendChild(copyButton);
        }
    }

    function createCopyPanel(appState: AppState): HTMLElement {
        const panel = document.createElement("div");
        panel.className = "copy-panel";
        panel.addEventListener("click", onCopyPanelClick);
        updateCopyPanel(panel, appState);
        return panel;
    }

    function updateCopyPanel(panel: HTMLElement, appState: AppState): void {
        const labels = ["Copy releases API URL", "Copy update API URL"];
        const texts = [buildApiReleasesUrl(appState.appName), buildApiUpdateUrl(appState.appName)];
        const update = appState.updateData;
        if (update !== null && update.assets.length > 0) {
            labels.push("Copy install command");
            texts.push(buildInstallCommand(appState.appName, update.version, update.assets[0].name));
        }
        const children = panel.children;
        for (let i = 0; i < labels.length; i = i + 1) {
            let button = children[i] as HTMLButtonElement | undefined;
            if (button === undefined || button.tagName !== "BUTTON") {
                button = createCopyButton(labels[i], texts[i]);
                panel.appendChild(button);
            } else {
                button.textContent = labels[i];
                button.setAttribute("data-copy-text", texts[i]);
            }
        }
        while (children.length > labels.length) {
            panel.removeChild(children[children.length - 1]);
        }
    }

    function createCopyButton(label: string, text: string): HTMLButtonElement {
        const button = document.createElement("button");
        button.type = "button";
        button.className = "btn btn-copy";
        button.textContent = label;
        button.setAttribute("data-copy-text", text);
        return button;
    }

    function createFilteredList(appState: AppState, filter: string): HTMLElement {
        const section = document.createElement("div");
        section.className = "release-list-section";
        section.addEventListener("click", onReleaseListClick);

        const title = document.createElement("h3");
        title.className = "release-list-title";
        title.textContent = "Releases";
        section.appendChild(title);

        const list = document.createElement("ul");
        list.className = "release-list";
        section.appendChild(list);

        updateFilteredList(section, appState, filter);
        return section;
    }

    function updateFilteredList(section: HTMLElement, appState: AppState, filter: string): void {
        const list = section.querySelector(".release-list");
        if (list === null) {
            section.replaceWith(createFilteredList(appState, filter));
            return;
        }
        list.innerHTML = "";
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
        notesButton.setAttribute("data-release-tag", release.tag);
        item.appendChild(notesButton);

        return item;
    }

    card.addEventListener("focusin", function onFocusIn(): void {
        if (store.getState().selectedAppName !== appName) {
            store.setSelectedApp(appName);
        }
    });

    store.subscribe(function onStoreChange(): void {
        render();
    });

    render();

    const appCard: AppCard = {
        element: card,
        load: loadReleases,
        selectVersion: selectVersion
    };
    return appCard;
}
