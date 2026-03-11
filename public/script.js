let APP_NAMES = {
    app1: "randmatqugea",
    app2: "desktopcalendartracking"
}
let state = {
    randmatqugea: { releases: [], currentVersion: null, assets: [] },
    desktopcalendartracking: { releases: [], currentVersion: null, assets: [] }
}
async function loadApp(appId) {
    let appName = APP_NAMES[appId]
    let container = document.getElementById(appId).querySelector(".app-content")
    try {
        let releasesResp = await fetch(`/api/releases/${appName}`)
        if (!releasesResp.ok) {
            container.innerHTML = "<p>No releases available.</p>"
            return
        }
        let releases = await releasesResp.json()
        if (releases.length == 0) {
            container.innerHTML = "<p>No releases available.</p>"
            return
        }
        state[appName].releases = releases
        let latestTag = releases[0].tag
        await loadVersion(appName, latestTag)
        renderApp(appId, appName)
    } catch (err) {
        container.innerHTML = "<p>Error loading data.</p>"
        console.error(err)
    }
}
async function loadVersion(appName, tag) {
    let resp = await fetch(`/api/update/${appName}?version=${encodeURIComponent(tag)}`)
    if (!resp.ok) throw new Error("Failed to fetch version")
    let data = await resp.json()
    state[appName].currentVersion = tag
    state[appName].assets = data.assets
}
function renderApp(appId, appName) {
    let container = document.getElementById(appId).querySelector(".app-content")
    let releases = state[appName].releases
    let currentVersion = state[appName].currentVersion
    let assets = state[appName].assets
    let options = ""
    for (let r of releases) {
        options += `<option value="${r.tag}" ${r.tag == currentVersion ? "selected" : ""}>${r.tag} (${new Date(r.published).toLocaleDateString()})</option>`
    }
    let buttonsHtml = ""
    for (let asset of assets) {
        let label = getPlatformLabel(asset.name)
        buttonsHtml += `<a class="btn btn-platform" href="/download/${appName}?version=${encodeURIComponent(currentVersion)}&asset=${encodeURIComponent(asset.name)}">⬇️ ${label}</a>`
    }
    let html = `
        <div class="version-selector">
            <label for="version-select-${appId}">📦 Version</label>
            <select id="version-select-${appId}" onchange="onVersionChange('${appName}', this.value)">
                ${options}
            </select>
        </div>
        <div class="button-group">
            <a class="btn btn-primary" href="/download/${appName}?version=${encodeURIComponent(currentVersion)}">💡 Smart Download (auto-detect)</a>
            ${buttonsHtml}
        </div>
        <div class="version-info">Current version: ${currentVersion}</div>
    `
    container.innerHTML = html
}
window.onVersionChange = async function (appName, tag) {
    await loadVersion(appName, tag)
    let appId = Object.keys(APP_NAMES).find(key => APP_NAMES[key] == appName)
    renderApp(appId, appName)
}
function getPlatformLabel(filename) {
    let name = filename.toLowerCase()
    let label = "Other"
    if (name.includes("windows") || name.endsWith(".exe") || name.endsWith(".msi")) {
        label = "Windows"
    } else if (name.includes("mac") || name.includes("osx") || name.endsWith(".dmg") || name.endsWith(".pkg")) {
        label = "macOS"
    } else if (name.includes("linux") || name.endsWith(".appimage") || name.endsWith(".deb") || name.endsWith(".rpm")) {
        label = "Linux"
    }
    if (name.includes("x64") || name.includes("amd64") || name.includes("intel") || name.includes("x86_64")) {
        label += " (x64)"
    } else if (name.includes("arm64") || name.includes("aarch64") || name.includes("apple silicon")) {
        label += " (ARM64)"
    } else if (name.includes("x86") || name.includes("i386")) {
        label += " (x86)"
    }
    return label
}
document.addEventListener("DOMContentLoaded", () => {
    loadApp("app1")
    loadApp("app2")
})
