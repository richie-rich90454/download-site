require("dotenv").config();
const express = require("express");
const axios = require("axios");
const fs = require("fs-extra");
const path = require("path");
const uaParser = require("ua-parser-js");

const app = express();
const PORT = process.env.PORT || 3000;
const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
const CACHE_DIR = process.env.CACHE_DIR || path.join(__dirname, "cache");
const MAX_RELEASES_TO_CACHE = 5;
const REPOS = {
    randmatqugea: process.env.APP1_REPO,
    desktopcalendartracking: process.env.APP2_REPO
};

let releasesCache = {};
let releaseByTagCache = {};
let downloadsInProgress = {};

const RELEASES_CACHE_TTL = 10 * 60 * 1000;
const RELEASE_TAG_CACHE_TTL = 10 * 60 * 1000;

async function githubGet(url) {
    const headers = GITHUB_TOKEN ? { Authorization: `token ${GITHUB_TOKEN}` } : {};
    try {
        console.log(`[GitHub API] GET ${url}`);
        const response = await axios.get(url, { headers });
        return response.data;
    } catch (err) {
        console.error(`[GitHub API Error] ${url}: ${err.message}`);
        return null;
    }
}

async function fetchAllReleases(appName) {
    const repo = REPOS[appName];
    if (!repo) return null;
    const url = `https://api.github.com/repos/${repo}/releases?per_page=10`;
    return await githubGet(url);
}

async function fetchReleaseByTag(appName, tag) {
    const repo = REPOS[appName];
    if (!repo) return null;
    const url = `https://api.github.com/repos/${repo}/releases/tags/${tag}`;
    return await githubGet(url);
}

async function getCachedReleases(appName) {
    const now = Date.now();
    if (releasesCache[appName] && now - releasesCache[appName].timestamp < RELEASES_CACHE_TTL) {
        console.log(`[Cache Hit] Releases for ${appName}`);
        return releasesCache[appName].data;
    }
    console.log(`[Cache Miss] Fetching releases for ${appName} from GitHub...`);
    const releases = await fetchAllReleases(appName);
    if (releases) {
        releasesCache[appName] = { timestamp: now, data: releases };
        console.log(`[Cache Update] Cached ${releases.length} releases for ${appName}`);
    }
    return releases;
}

async function getCachedReleaseByTag(appName, tag) {
    const key = `${appName}_${tag}`;
    const now = Date.now();
    if (releaseByTagCache[key] && now - releaseByTagCache[key].timestamp < RELEASE_TAG_CACHE_TTL) {
        console.log(`[Cache Hit] Release ${tag} for ${appName}`);
        return releaseByTagCache[key].data;
    }
    console.log(`[Cache Miss] Fetching release ${tag} for ${appName} from GitHub...`);
    const release = await fetchReleaseByTag(appName, tag);
    if (release) {
        releaseByTagCache[key] = { timestamp: now, data: release };
        console.log(`[Cache Update] Cached release ${tag} for ${appName}`);
    }
    return release;
}

function getLocalPath(appName, version, assetName) {
    return path.join(CACHE_DIR, appName, version, assetName);
}

async function downloadAsset(appName, asset, version) {
    const versionDir = path.join(CACHE_DIR, appName, version);
    await fs.ensureDir(versionDir);
    const localPath = path.join(versionDir, asset.name);
    const downloadUrl = asset.browser_download_url;
    console.log(`[Download Start] ${asset.name} (${version}) for ${appName}`);
    const writer = fs.createWriteStream(localPath);
    const response = await axios({
        method: "get",
        url: downloadUrl,
        responseType: "stream",
        headers: GITHUB_TOKEN ? { Authorization: `token ${GITHUB_TOKEN}` } : {}
    });
    response.data.pipe(writer);
    return new Promise((resolve, reject) => {
        writer.on("finish", () => {
            console.log(`[Download Complete] ${asset.name} (${version}) for ${appName}`);
            resolve(localPath);
        });
        writer.on("error", (err) => {
            console.error(`[Download Error] ${asset.name} (${version}) for ${appName}: ${err.message}`);
            reject(err);
        });
    });
}

async function ensureAssetCached(appName, asset, version) {
    const assetKey = `${appName}/${version}/${asset.name}`;
    const localPath = getLocalPath(appName, version, asset.name);
    if (await fs.pathExists(localPath)) {
        console.log(`[Cache Hit] Asset exists: ${asset.name} (${version}) for ${appName}`);
        return localPath;
    }
    if (downloadsInProgress[assetKey]) {
        console.log(`[Download Pending] Waiting for in-progress download: ${asset.name} (${version}) for ${appName}`);
        return downloadsInProgress[assetKey];
    }
    const downloadPromise = (async () => {
        try {
            return await downloadAsset(appName, asset, version);
        } finally {
            delete downloadsInProgress[assetKey];
        }
    })();
    downloadsInProgress[assetKey] = downloadPromise;
    return downloadPromise;
}

async function refreshAllApps() {
    console.log("=== Background Refresh Start ===");
    for (const appName of Object.keys(REPOS)) {
        try {
            console.log(`[Refresh] Checking releases for ${appName}...`);
            const releases = await fetchAllReleases(appName);
            if (!releases || releases.length === 0) {
                console.warn(`[Refresh] No releases found for ${appName}`);
                continue;
            }
            releasesCache[appName] = { timestamp: Date.now(), data: releases };
            const recentReleases = releases.slice(0, MAX_RELEASES_TO_CACHE);
            for (const release of recentReleases) {
                const version = release.tag_name;
                console.log(`[Refresh] Caching assets for ${appName} ${version}...`);
                for (const asset of release.assets) {
                    ensureAssetCached(appName, asset, version).catch(err => {
                        console.error(`[Refresh] Failed caching ${appName}/${asset.name}: ${err.message}`);
                    });
                }
            }
        } catch (err) {
            console.error(`[Refresh] Error refreshing ${appName}: ${err.message}`);
        }
    }
    console.log("=== Background Refresh Complete ===");
}

app.get("/api/releases/:app", async (req, res) => {
    const appName = req.params.app.toLowerCase();
    const releases = await getCachedReleases(appName);
    if (!releases) return res.status(404).json({ error: "App not found or no releases" });
    const list = releases.map(r => ({ tag: r.tag_name, published: r.published_at }));
    res.json(list);
});

app.get("/api/update/:app", async (req, res) => {
    const appName = req.params.app.toLowerCase();
    const version = req.query.version;
    let release;
    if (version) {
        release = await getCachedReleaseByTag(appName, version);
    } else {
        const releases = await getCachedReleases(appName);
        release = releases && releases.length > 0 ? releases[0] : null;
    }
    if (!release) return res.status(404).json({ error: "Release not found" });

    const assets = release.assets.map(a => ({
        name: a.name,
        url: `/download/${appName}?version=${encodeURIComponent(release.tag_name)}&asset=${encodeURIComponent(a.name)}`,
        size: a.size,
        browser_download_url: a.browser_download_url
    }));
    res.json({
        version: release.tag_name,
        published_at: release.published_at,
        release_notes: release.body,
        assets
    });
});

app.get("/download/:app", async (req, res) => {
    const appName = req.params.app.toLowerCase();
    const { version, asset: assetName, platform: platformHint } = req.query;
    const userAgent = req.headers["user-agent"];

    let release;
    if (version) {
        release = await getCachedReleaseByTag(appName, version);
    } else {
        const releases = await getCachedReleases(appName);
        release = releases && releases.length > 0 ? releases[0] : null;
    }
    if (!release || !release.assets.length) return res.status(404).send("Release not found");

    let asset;
    if (assetName) {
        asset = release.assets.find(a => a.name === assetName);
        if (!asset) return res.status(404).send("Asset not found");
    } else {
        asset = selectAssetForPlatform(release.assets, userAgent, platformHint);
    }

    try {
        const localPath = await ensureAssetCached(appName, asset, release.tag_name);
        console.log(`[Serve] Sending ${asset.name} (${release.tag_name}) for ${appName}`);
        res.set("Content-Disposition", `attachment; filename="${path.basename(localPath)}"`);
        res.set("Cache-Control", "public, max-age=31536000");
        res.sendFile(localPath);
    } catch (err) {
        console.error(`[Serve Error] Failed to serve ${asset.name}: ${err.message}`);
        res.status(500).send("Failed to serve file");
    }
});

function selectAssetForPlatform(assets, userAgent, platformHint) {
    let os = "", arch = "";
    if (platformHint) {
        const parts = platformHint.toLowerCase().split("_");
        os = parts[0]; arch = parts[1] || "";
    } else if (userAgent) {
        const ua = uaParser(userAgent);
        const osName = ua.os.name?.toLowerCase() || "";
        if (osName.includes("windows")) os = "windows";
        else if (osName.includes("mac")) os = "mac";
        else if (osName.includes("linux")) os = "linux";
        const cpuArch = ua.cpu?.architecture?.toLowerCase() || "";
        if (cpuArch.includes("64") || cpuArch.includes("amd64") || cpuArch.includes("x86_64")) arch = "x64";
        else if (cpuArch.includes("arm") || cpuArch.includes("aarch")) arch = "arm64";
    }
    function scoreAsset(asset) {
        const name = asset.name.toLowerCase();
        let score = 0;
        if (os && name.includes(os)) score += 10;
        if (arch && name.includes(arch)) score += 5;
        if (os === "windows" && (name.endsWith(".exe") || name.endsWith(".msi"))) score += 8;
        if (os === "mac" && (name.endsWith(".dmg") || name.endsWith(".pkg"))) score += 8;
        if (os === "linux" && (name.endsWith(".appimage") || name.endsWith(".deb") || name.endsWith(".rpm"))) score += 8;
        return score;
    }
    const scored = assets.map(asset => ({ asset, score: scoreAsset(asset) }));
    scored.sort((a, b) => b.score - a.score);
    console.log(`[Platform Detection] os=${os}, arch=${arch}`);
    scored.forEach(s => console.log(`  Asset: ${s.asset.name}, Score=${s.score}`));
    return scored[0]?.asset || assets[0];
}

app.use(express.static(path.join(__dirname, "public")));
app.use((req, res) => res.sendFile(path.join(__dirname, "public", "index.html")));

app.listen(PORT, async () => {
    console.log(`Server running on http://localhost:${PORT}`);
    console.log(`Cache directory: ${CACHE_DIR}`);
    await refreshAllApps();
    setInterval(refreshAllApps, 24 * 60 * 60 * 1000);
});