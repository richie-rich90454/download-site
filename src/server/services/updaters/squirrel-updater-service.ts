import * as types from "../../../shared/types.js";
import * as platform from "../../platform/platform-detector.js";
import * as release from "../release-service.js";
import * as download from "../download-service.js";
import * as helpers from "./updater-helpers.js";
import * as updaterTypes from "./updater-types.js";

export class SquirrelUpdaterService {
    private readonly releaseService: release.ReleaseService;
    private readonly downloadService: download.DownloadService;
    private readonly detector: platform.PlatformDetector;

    constructor(
        releaseService: release.ReleaseService,
        downloadService: download.DownloadService,
        detector: platform.PlatformDetector
    ) {
        this.releaseService = releaseService;
        this.downloadService = downloadService;
        this.detector = detector;
    }

    async getUpdate(context: updaterTypes.UpdaterContext): Promise<updaterTypes.UpdaterResult> {
        const releaseObj = await this.releaseService.getLatestRelease(context.appId, false);
        if (releaseObj === undefined) {
            return { status: 404, body: { error: "No release found" } };
        }
        if (helpers.isUpToDate(context.currentVersion, releaseObj.tag)) {
            return { status: 204, body: undefined };
        }
        const target = { os: "windows" as types.Platform, arch: "x64" };
        const asset = this.detector.selectAsset(releaseObj.assets, target);
        if (asset === undefined) {
            return { status: 404, body: { error: "No Windows asset found" } };
        }
        const url = helpers.buildAssetUrl(this.downloadService, context.appId, releaseObj.tag, asset.name);
        const manifest: updaterTypes.SquirrelManifest = {
            url: url,
            name: releaseObj.name,
            notes: releaseObj.notes,
            pub_date: releaseObj.publishedAt
        };
        return { status: 200, body: manifest };
    }
}
