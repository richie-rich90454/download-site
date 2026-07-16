import * as dotenv from "dotenv";
import * as fs from "node:fs";
import * as path from "node:path";
import * as z from "zod";
import * as types from "../../shared/types.js";

dotenv.config();

export interface ServerConfig {
    port: number;
    cacheDir: string;
    logLevel: string;
    corsOrigin: string | undefined;
    github: {
        token: string | undefined;
        appId: string | undefined;
        privateKey: string | undefined;
    };
    rateLimits: {
        max: number;
        timeWindow: number;
    };
    apps: types.App[];
}

const AppConfigSchema = z.object({
    id: z.string().min(1),
    repo: z.string().min(1),
    name: z.string().min(1)
});

const envSchema = z.object({
    PORT: z.coerce.number().int().positive(),
    CACHE_DIR: z.string().min(1),
    APPS: z.string().min(1),
    GITHUB_TOKEN: z.string().optional(),
    GITHUB_APP_ID: z.string().optional(),
    GITHUB_PRIVATE_KEY: z.string().optional(),
    CONFIG_PATH: z.string().optional(),
    LOG_LEVEL: z.string().optional(),
    CORS_ORIGIN: z.string().optional()
});

export type RawEnv = z.infer<typeof envSchema>;

function parseApps(json: string): types.App[] {
    let parsed: unknown;
    try {
        parsed = JSON.parse(json) as unknown;
    } catch (err) {
        const message = String(err);
        throw new Error("APPS is not valid JSON: " + message, { cause: err });
    }
    if (!Array.isArray(parsed)) {
        throw new Error("APPS must be a JSON array");
    }
    const result: types.App[] = [];
    for (let i = 0; i < parsed.length; i = i + 1) {
        const item = parsed[i];
        const validated = AppConfigSchema.parse(item);
        result.push({
            id: validated.id,
            repo: validated.repo,
            name: validated.name
        });
    }
    return result;
}

function readConfigFile(configPath: string): string {
    if (!fs.existsSync(configPath)) {
        throw new Error("CONFIG_PATH file does not exist: " + configPath);
    }
    return fs.readFileSync(configPath, "utf8");
}

function parseConfigObject(raw: string): Record<string, unknown> {
    let parsed: unknown;
    try {
        parsed = JSON.parse(raw) as unknown;
    } catch (err) {
        throw new Error("CONFIG_PATH file is not valid JSON: " + String(err), { cause: err });
    }
    if (parsed === null || typeof parsed !== "object") {
        throw new Error("CONFIG_PATH file must contain a JSON object");
    }
    return parsed as Record<string, unknown>;
}

function readGitHubOverride(obj: Record<string, unknown>): ServerConfig["github"] {
    const token = "token" in obj ? String(obj.token) : undefined;
    const appId = "appId" in obj ? String(obj.appId) : undefined;
    const privateKey = "privateKey" in obj ? String(obj.privateKey) : undefined;
    return {
        token: token,
        appId: appId,
        privateKey: privateKey
    };
}

function readRateLimitsOverride(obj: Record<string, unknown>): ServerConfig["rateLimits"] {
    const max = "max" in obj ? Number(obj.max) : 100;
    const timeWindow = "timeWindow" in obj ? Number(obj.timeWindow) : 60000;
    return {
        max: max,
        timeWindow: timeWindow
    };
}

function loadConfigPath(configPath: string): Partial<ServerConfig> {
    const raw = readConfigFile(configPath);
    const obj = parseConfigObject(raw);
    const result: Partial<ServerConfig> = {};
    if ("port" in obj) {
        result.port = Number(obj.port);
    }
    if ("cacheDir" in obj) {
        result.cacheDir = String(obj.cacheDir);
    }
    if ("logLevel" in obj) {
        result.logLevel = String(obj.logLevel);
    }
    if ("corsOrigin" in obj) {
        result.corsOrigin = String(obj.corsOrigin);
    }
    if ("github" in obj) {
        const githubValue = obj.github;
        if (githubValue !== null && typeof githubValue === "object") {
            result.github = readGitHubOverride(githubValue as Record<string, unknown>);
        }
    }
    if ("rateLimits" in obj) {
        const rateLimitsValue = obj.rateLimits;
        if (rateLimitsValue !== null && typeof rateLimitsValue === "object") {
            result.rateLimits = readRateLimitsOverride(rateLimitsValue as Record<string, unknown>);
        }
    }
    if ("apps" in obj) {
        const appsValue = obj.apps;
        if (Array.isArray(appsValue)) {
            result.apps = parseApps(JSON.stringify(appsValue));
        }
    }
    return result;
}

function applyOverride(config: ServerConfig, override: Partial<ServerConfig>): ServerConfig {
    if (override.port !== undefined) {
        config.port = override.port;
    }
    if (override.cacheDir !== undefined) {
        config.cacheDir = path.resolve(override.cacheDir);
    }
    if (override.logLevel !== undefined) {
        config.logLevel = override.logLevel;
    }
    if (override.corsOrigin !== undefined) {
        config.corsOrigin = override.corsOrigin;
    }
    if (override.github !== undefined) {
        config.github = override.github;
    }
    if (override.rateLimits !== undefined) {
        config.rateLimits = override.rateLimits;
    }
    if (override.apps !== undefined) {
        config.apps = override.apps;
    }
    return config;
}

function buildConfig(env: RawEnv): ServerConfig {
    const apps = parseApps(env.APPS);
    const logLevel = env.LOG_LEVEL !== undefined ? env.LOG_LEVEL : "info";
    let config: ServerConfig = {
        port: env.PORT,
        cacheDir: path.resolve(env.CACHE_DIR),
        logLevel: logLevel,
        corsOrigin: env.CORS_ORIGIN,
        github: {
            token: env.GITHUB_TOKEN,
            appId: env.GITHUB_APP_ID,
            privateKey: env.GITHUB_PRIVATE_KEY
        },
        rateLimits: {
            max: 100,
            timeWindow: 60000
        },
        apps: apps
    };
    if (env.CONFIG_PATH !== undefined) {
        const override = loadConfigPath(env.CONFIG_PATH);
        config = applyOverride(config, override);
    }
    return config;
}

export function loadConfig(): ServerConfig {
    const env = envSchema.parse(process.env);
    return buildConfig(env);
}
