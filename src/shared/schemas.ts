import * as z from "zod";

/**
 * Schemas for the boundary we do not control: the GitHub releases API.
 *
 * Everything here validates a response before it reaches the cache or an updater, so a surprise
 * upstream shape fails at the edge instead of somewhere deep in an asset selector. The rest of
 * the system relies on the TypeScript types in types.ts, and route input is validated with the
 * JSON Schema the routes already declare.
 */

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
