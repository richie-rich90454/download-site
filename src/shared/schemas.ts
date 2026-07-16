import * as z from "zod";

export const PlatformSchema = z.enum(["windows", "darwin", "linux"]);

export const AppSchema = z.object({
    id: z.string().min(1),
    repo: z.string().min(1),
    name: z.string().min(1)
});

export const GitHubAssetSchema = z.object({
    name: z.string(),
    size: z.number().int().nonnegative(),
    content_type: z.string(),
    url: z.string().url(),
    browser_download_url: z.string().url()
});

export const GitHubReleaseSchema = z.object({
    tag_name: z.string(),
    name: z.string(),
    body: z.string().nullable(),
    published_at: z.string(),
    prerelease: z.boolean(),
    assets: z.array(GitHubAssetSchema)
});

export const AssetSchema = z.object({
    name: z.string(),
    size: z.number().int().nonnegative(),
    contentType: z.string(),
    url: z.string().url(),
    browserDownloadUrl: z.string().url()
});

export const ReleaseSchema = z.object({
    tag: z.string(),
    name: z.string(),
    notes: z.string(),
    publishedAt: z.string(),
    prerelease: z.boolean(),
    assets: z.array(AssetSchema)
});

export const TargetSchema = z.object({
    os: PlatformSchema,
    arch: z.string()
});

export const UpdateManifestSchema = z.object({
    version: z.string(),
    notes: z.string(),
    pubDate: z.string(),
    platforms: z.record(
        z.string(),
        z.object({
            signature: z.string(),
            url: z.string().url()
        })
    )
});

export const AppParamsSchema = z.object({
    app: z.string().min(1)
});

export const VersionQuerySchema = z.object({
    version: z.string().optional()
});

export const DownloadQuerySchema = z.object({
    version: z.string().optional(),
    asset: z.string().optional(),
    platform: z.string().optional()
});

export const TauriUpdateQuerySchema = z.object({
    target: z.string().min(1),
    current_version: z.string().optional(),
    version: z.string().optional()
});

export const GenericUpdateQuerySchema = z.object({
    version: z.string().optional(),
    current_version: z.string().optional()
});
