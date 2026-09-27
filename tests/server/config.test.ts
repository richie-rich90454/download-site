import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as config from "../../src/server/config/config.js";

describe("loadConfig", function () {
    const originalPort = process.env.PORT;
    const originalCacheDir = process.env.CACHE_DIR;
    const originalApps = process.env.APPS;
    const originalLogLevel = process.env.LOG_LEVEL;
    const originalConfigPath = process.env.CONFIG_PATH;
    const originalGithubToken = process.env.GITHUB_TOKEN;
    const originalMaxCacheableSize = process.env.MAX_CACHEABLE_SIZE;
    const originalAdminApiKey = process.env.ADMIN_API_KEY;
    const originalWebhookSecret = process.env.WEBHOOK_SECRET;
    const originalPublicBaseUrl = process.env.PUBLIC_BASE_URL;

    beforeEach(function () {
        delete process.env.PORT;
        delete process.env.CACHE_DIR;
        delete process.env.APPS;
        delete process.env.LOG_LEVEL;
        delete process.env.CONFIG_PATH;
        delete process.env.GITHUB_TOKEN;
        delete process.env.MAX_CACHEABLE_SIZE;
        // The real .env is loaded by dotenv at import time; clear the secrets so each case
        // starts from a known state rather than inheriting a developer's local values.
        delete process.env.ADMIN_API_KEY;
        delete process.env.WEBHOOK_SECRET;
        delete process.env.PUBLIC_BASE_URL;
    });

    afterEach(function () {
        process.env.PORT = originalPort;
        process.env.CACHE_DIR = originalCacheDir;
        process.env.APPS = originalApps;
        process.env.LOG_LEVEL = originalLogLevel;
        process.env.CONFIG_PATH = originalConfigPath;
        process.env.GITHUB_TOKEN = originalGithubToken;
        process.env.MAX_CACHEABLE_SIZE = originalMaxCacheableSize;
        if (originalAdminApiKey === undefined) {
            delete process.env.ADMIN_API_KEY;
        } else {
            process.env.ADMIN_API_KEY = originalAdminApiKey;
        }
        if (originalWebhookSecret === undefined) {
            delete process.env.WEBHOOK_SECRET;
        } else {
            process.env.WEBHOOK_SECRET = originalWebhookSecret;
        }
        if (originalPublicBaseUrl === undefined) {
            delete process.env.PUBLIC_BASE_URL;
        } else {
            process.env.PUBLIC_BASE_URL = originalPublicBaseUrl;
        }
    });

    it("loads required configuration", function () {
        process.env.PORT = "3000";
        process.env.CACHE_DIR = "./cache";
        process.env.APPS = JSON.stringify([{ id: "app1", repo: "owner/repo", name: "App One" }]);
        process.env.LOG_LEVEL = "debug";

        const cfg = config.loadConfig();

        expect(cfg.port).toBe(3000);
        expect(cfg.cacheDir.indexOf("cache") >= 0).toBe(true);
        expect(cfg.logLevel).toBe("debug");
        expect(cfg.apps.length).toBe(1);
        expect(cfg.apps[0].id).toBe("app1");
    });

    it("exposes the admin and webhook secrets on the config", function () {
        process.env.PORT = "3000";
        process.env.CACHE_DIR = "./cache";
        process.env.APPS = JSON.stringify([{ id: "app1", repo: "owner/repo", name: "App One" }]);
        process.env.ADMIN_API_KEY = "a-sufficiently-long-admin-key-value";
        process.env.WEBHOOK_SECRET = "a-sufficiently-long-webhook-secret";

        const cfg = config.loadConfig();

        expect(cfg.adminApiKey).toBe("a-sufficiently-long-admin-key-value");
        expect(cfg.webhookSecret).toBe("a-sufficiently-long-webhook-secret");
    });

    it("leaves the secrets undefined when unset, which disables those surfaces", function () {
        process.env.PORT = "3000";
        process.env.CACHE_DIR = "./cache";
        process.env.APPS = JSON.stringify([{ id: "app1", repo: "owner/repo", name: "App One" }]);

        const cfg = config.loadConfig();

        expect(cfg.adminApiKey).toBeUndefined();
        expect(cfg.webhookSecret).toBeUndefined();
    });

    it("refuses to start when the admin key is shorter than the minimum", function () {
        process.env.PORT = "3000";
        process.env.CACHE_DIR = "./cache";
        process.env.APPS = JSON.stringify([{ id: "app1", repo: "owner/repo", name: "App One" }]);
        process.env.ADMIN_API_KEY = "short";

        expect(function () {
            config.loadConfig();
        }).toThrow("ADMIN_API_KEY is set but shorter than 32 characters");
    });

    it("refuses to start when the webhook secret is shorter than the minimum", function () {
        process.env.PORT = "3000";
        process.env.CACHE_DIR = "./cache";
        process.env.APPS = JSON.stringify([{ id: "app1", repo: "owner/repo", name: "App One" }]);
        process.env.WEBHOOK_SECRET = "short";

        expect(function () {
            config.loadConfig();
        }).toThrow("WEBHOOK_SECRET is set but shorter than 32 characters");
    });

    it("uses PUBLIC_BASE_URL for absolute updater URLs", function () {
        process.env.PORT = "3000";
        process.env.CACHE_DIR = "./cache";
        process.env.APPS = JSON.stringify([{ id: "app1", repo: "owner/repo", name: "App One" }]);
        process.env.PUBLIC_BASE_URL = "https://mirror.example.com";

        const cfg = config.loadConfig();

        expect(cfg.publicBaseUrl).toBe("https://mirror.example.com");
    });

    it("strips trailing slashes from PUBLIC_BASE_URL", function () {
        process.env.PORT = "3000";
        process.env.CACHE_DIR = "./cache";
        process.env.APPS = JSON.stringify([{ id: "app1", repo: "owner/repo", name: "App One" }]);
        process.env.PUBLIC_BASE_URL = "https://mirror.example.com///";

        const cfg = config.loadConfig();

        expect(cfg.publicBaseUrl).toBe("https://mirror.example.com");
    });

    it("falls back to localhost outside production", function () {
        process.env.PORT = "4321";
        process.env.CACHE_DIR = "./cache";
        process.env.APPS = JSON.stringify([{ id: "app1", repo: "owner/repo", name: "App One" }]);
        const originalNodeEnv = process.env.NODE_ENV;
        delete process.env.NODE_ENV;
        try {
            const cfg = config.loadConfig();

            expect(cfg.publicBaseUrl).toBe("http://localhost:4321");
        } finally {
            if (originalNodeEnv === undefined) {
                delete process.env.NODE_ENV;
            } else {
                process.env.NODE_ENV = originalNodeEnv;
            }
        }
    });

    it("refuses to start in production without PUBLIC_BASE_URL", function () {
        process.env.PORT = "3000";
        process.env.CACHE_DIR = "./cache";
        process.env.APPS = JSON.stringify([{ id: "app1", repo: "owner/repo", name: "App One" }]);
        const originalNodeEnv = process.env.NODE_ENV;
        process.env.NODE_ENV = "production";
        try {
            expect(function () {
                config.loadConfig();
            }).toThrow("PUBLIC_BASE_URL is required when NODE_ENV=production");
        } finally {
            if (originalNodeEnv === undefined) {
                delete process.env.NODE_ENV;
            } else {
                process.env.NODE_ENV = originalNodeEnv;
            }
        }
    });

    it("defaults log level to info", function () {
        process.env.PORT = "3000";
        process.env.CACHE_DIR = "./cache";
        process.env.APPS = JSON.stringify([{ id: "app1", repo: "owner/repo", name: "App One" }]);

        const cfg = config.loadConfig();

        expect(cfg.logLevel).toBe("info");
    });

    it("uses custom MAX_CACHEABLE_SIZE from environment", function () {
        process.env.PORT = "3000";
        process.env.CACHE_DIR = "./cache";
        process.env.APPS = JSON.stringify([{ id: "app1", repo: "owner/repo", name: "App One" }]);
        process.env.MAX_CACHEABLE_SIZE = "2048";

        const cfg = config.loadConfig();

        expect(cfg.assetCache !== undefined ? cfg.assetCache.maxCacheableSize : undefined).toBe(2048);
    });

    it("throws when PORT is missing", function () {
        process.env.CACHE_DIR = "./cache";
        process.env.APPS = JSON.stringify([{ id: "app1", repo: "owner/repo", name: "App One" }]);

        expect(function () {
            config.loadConfig();
        }).toThrow();
    });

    it("throws when APPS is invalid JSON", function () {
        process.env.PORT = "3000";
        process.env.CACHE_DIR = "./cache";
        process.env.APPS = "not-json";

        expect(function () {
            config.loadConfig();
        }).toThrow("APPS is not valid JSON");
    });

    it("throws when APPS is not an array", function () {
        process.env.PORT = "3000";
        process.env.CACHE_DIR = "./cache";
        process.env.APPS = JSON.stringify({ id: "app1" });

        expect(function () {
            config.loadConfig();
        }).toThrow("APPS must be a JSON array");
    });

    it("applies CONFIG_PATH override", function () {
        process.env.PORT = "3000";
        process.env.CACHE_DIR = "./cache";
        process.env.APPS = JSON.stringify([{ id: "app1", repo: "owner/repo", name: "App One" }]);

        const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "download-server-"));
        const configPath = path.join(tempDir, "override.json");
        const override = {
            port: 4000,
            logLevel: "warn"
        };
        fs.writeFileSync(configPath, JSON.stringify(override));
        process.env.CONFIG_PATH = configPath;

        const cfg = config.loadConfig();

        expect(cfg.port).toBe(4000);
        expect(cfg.logLevel).toBe("warn");

        fs.unlinkSync(configPath);
        fs.rmdirSync(tempDir);
    });

    it("throws when CONFIG_PATH file does not exist", function () {
        process.env.PORT = "3000";
        process.env.CACHE_DIR = "./cache";
        process.env.APPS = JSON.stringify([{ id: "app1", repo: "owner/repo", name: "App One" }]);
        process.env.CONFIG_PATH = path.join(os.tmpdir(), "does-not-exist.json");

        expect(function () {
            config.loadConfig();
        }).toThrow("CONFIG_PATH file does not exist");
    });

    it("throws when CONFIG_PATH file is invalid JSON", function () {
        process.env.PORT = "3000";
        process.env.CACHE_DIR = "./cache";
        process.env.APPS = JSON.stringify([{ id: "app1", repo: "owner/repo", name: "App One" }]);

        const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "download-server-"));
        const configPath = path.join(tempDir, "override.json");
        fs.writeFileSync(configPath, "not-json");
        process.env.CONFIG_PATH = configPath;

        expect(function () {
            config.loadConfig();
        }).toThrow("CONFIG_PATH file is not valid JSON");

        fs.unlinkSync(configPath);
        fs.rmdirSync(tempDir);
    });

    it("throws when CONFIG_PATH file is not an object", function () {
        process.env.PORT = "3000";
        process.env.CACHE_DIR = "./cache";
        process.env.APPS = JSON.stringify([{ id: "app1", repo: "owner/repo", name: "App One" }]);

        const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "download-server-"));
        const configPath = path.join(tempDir, "override.json");
        fs.writeFileSync(configPath, JSON.stringify("string"));
        process.env.CONFIG_PATH = configPath;

        expect(function () {
            config.loadConfig();
        }).toThrow("CONFIG_PATH file must contain a JSON object");

        fs.unlinkSync(configPath);
        fs.rmdirSync(tempDir);
    });

    it("applies full CONFIG_PATH override", function () {
        process.env.PORT = "3000";
        process.env.CACHE_DIR = "./cache";
        process.env.APPS = JSON.stringify([{ id: "app1", repo: "owner/repo", name: "App One" }]);

        const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "download-server-"));
        const configPath = path.join(tempDir, "override.json");
        const override = {
            port: 4000,
            cacheDir: path.join(tempDir, "cache"),
            logLevel: "silent",
            corsOrigin: "https://example.com",
            github: {
                token: "token",
                appId: "app-id",
                privateKey: "key"
            },
            rateLimits: {
                max: 50,
                timeWindow: 30000
            },
            apps: [{ id: "app2", repo: "owner/repo2", name: "App Two" }]
        };
        fs.writeFileSync(configPath, JSON.stringify(override));
        process.env.CONFIG_PATH = configPath;

        const cfg = config.loadConfig();

        expect(cfg.port).toBe(4000);
        expect(cfg.cacheDir).toBe(path.join(tempDir, "cache"));
        expect(cfg.logLevel).toBe("silent");
        expect(cfg.corsOrigin).toBe("https://example.com");
        expect(cfg.github.token).toBe("token");
        expect(cfg.github.appId).toBe("app-id");
        expect(cfg.github.privateKey).toBe("key");
        expect(cfg.rateLimits.max).toBe(50);
        expect(cfg.rateLimits.timeWindow).toBe(30000);
        expect(cfg.apps.length).toBe(1);
        expect(cfg.apps[0].id).toBe("app2");

        fs.unlinkSync(configPath);
        fs.rmdirSync(tempDir);
    });

    it("keeps base values when override omits port and cacheDir", function () {
        process.env.PORT = "3000";
        process.env.CACHE_DIR = "./cache";
        process.env.APPS = JSON.stringify([{ id: "app1", repo: "owner/repo", name: "App One" }]);

        const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "download-server-"));
        const configPath = path.join(tempDir, "override.json");
        const override = {
            logLevel: "silent"
        };
        fs.writeFileSync(configPath, JSON.stringify(override));
        process.env.CONFIG_PATH = configPath;

        const cfg = config.loadConfig();

        expect(cfg.port).toBe(3000);
        expect(cfg.cacheDir).toBe(path.resolve("./cache"));
        expect(cfg.logLevel).toBe("silent");

        fs.unlinkSync(configPath);
        fs.rmdirSync(tempDir);
    });

    it("applies partial github and rateLimits override", function () {
        process.env.PORT = "3000";
        process.env.CACHE_DIR = "./cache";
        process.env.APPS = JSON.stringify([{ id: "app1", repo: "owner/repo", name: "App One" }]);

        const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "download-server-"));
        const configPath = path.join(tempDir, "override.json");
        const override = {
            github: {},
            rateLimits: {}
        };
        fs.writeFileSync(configPath, JSON.stringify(override));
        process.env.CONFIG_PATH = configPath;

        const cfg = config.loadConfig();

        expect(cfg.github.token).toBeUndefined();
        expect(cfg.github.appId).toBeUndefined();
        expect(cfg.github.privateKey).toBeUndefined();
        expect(cfg.rateLimits.max).toBe(100);
        expect(cfg.rateLimits.timeWindow).toBe(60000);
        expect(cfg.rateLimits.burst).toBeUndefined();

        fs.unlinkSync(configPath);
        fs.rmdirSync(tempDir);
    });

    it("reads a burst from the config file override", function () {
        process.env.PORT = "3000";
        process.env.CACHE_DIR = "./cache";
        process.env.APPS = JSON.stringify([{ id: "app1", repo: "owner/repo", name: "App One" }]);

        const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "download-server-"));
        const configPath = path.join(tempDir, "override.json");
        const override = { rateLimits: { max: 200, timeWindow: 30000, burst: 25 } };
        fs.writeFileSync(configPath, JSON.stringify(override));
        process.env.CONFIG_PATH = configPath;

        const cfg = config.loadConfig();

        expect(cfg.rateLimits.max).toBe(200);
        expect(cfg.rateLimits.timeWindow).toBe(30000);
        expect(cfg.rateLimits.burst).toBe(25);

        fs.unlinkSync(configPath);
        fs.rmdirSync(tempDir);
    });

    it("ignores non-object github and rateLimits and non-array apps", function () {
        process.env.PORT = "3000";
        process.env.CACHE_DIR = "./cache";
        process.env.APPS = JSON.stringify([{ id: "app1", repo: "owner/repo", name: "App One" }]);

        const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "download-server-"));
        const configPath = path.join(tempDir, "override.json");
        const override = {
            github: "bad",
            rateLimits: "bad",
            apps: "bad"
        };
        fs.writeFileSync(configPath, JSON.stringify(override));
        process.env.CONFIG_PATH = configPath;

        const cfg = config.loadConfig();

        expect(cfg.github.token).toBeUndefined();
        expect(cfg.rateLimits.max).toBe(100);
        expect(cfg.apps.length).toBe(1);
        expect(cfg.apps[0].id).toBe("app1");

        fs.unlinkSync(configPath);
        fs.rmdirSync(tempDir);
    });
});
