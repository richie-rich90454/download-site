import { describe, test, expect } from "vitest";
import { createStore } from "../../src/public/state.js";

describe("state", function () {
    test("createStore starts empty", function () {
        const store = createStore();
        expect(store.getState().apps.length).toBe(0);
    });

    test("registerApp adds an app", function () {
        const store = createStore();
        store.registerApp("randmatqugea", "RandMatQuGeA");
        expect(store.getState().apps.length).toBe(1);
        expect(store.getState().apps[0].appName).toBe("randmatqugea");
    });

    test("setReleases sets releases and default version", function () {
        const store = createStore();
        store.registerApp("randmatqugea", "RandMatQuGeA");
        store.setReleases("randmatqugea", [
            {
                tag: "v1.1.0",
                name: "v1.1.0",
                notes: "",
                publishedAt: "2024-02-01T00:00:00Z",
                prerelease: false,
                assets: []
            },
            {
                tag: "v1.0.0",
                name: "v1.0.0",
                notes: "",
                publishedAt: "2024-01-01T00:00:00Z",
                prerelease: false,
                assets: []
            }
        ]);
        expect(store.getState().apps[0].releases.length).toBe(2);
        expect(store.getState().apps[0].selectedVersion).toBe("v1.1.0");
    });

    test("subscribe notifies listeners", function () {
        const store = createStore();
        let calls = 0;
        store.subscribe(function () {
            calls = calls + 1;
        });
        store.registerApp("randmatqugea", "RandMatQuGeA");
        expect(calls).toBe(1);
    });

    test("setFilter updates filter", function () {
        const store = createStore();
        store.setFilter("windows");
        expect(store.getState().filter).toBe("windows");
    });

    test("registerApp ignores duplicate registrations", function () {
        const store = createStore();
        store.registerApp("randmatqugea", "RandMatQuGeA");
        store.registerApp("randmatqugea", "RandMatQuGeA");
        expect(store.getState().apps.length).toBe(1);
    });

    test("setReleases ignores unknown app", function () {
        const store = createStore();
        store.setReleases("unknown", [
            {
                tag: "v1.0.0",
                name: "v1.0.0",
                notes: "",
                publishedAt: "2024-01-01T00:00:00Z",
                prerelease: false,
                assets: []
            }
        ]);
        expect(store.getState().apps.length).toBe(0);
    });

    test("setReleases does not change version when already selected", function () {
        const store = createStore();
        store.registerApp("randmatqugea", "RandMatQuGeA");
        store.selectVersion("randmatqugea", "v1.0.0");
        store.setReleases("randmatqugea", [
            {
                tag: "v1.1.0",
                name: "v1.1.0",
                notes: "",
                publishedAt: "2024-02-01T00:00:00Z",
                prerelease: false,
                assets: []
            }
        ]);
        expect(store.getState().apps[0].selectedVersion).toBe("v1.0.0");
    });

    test("selectVersion ignores unknown app", function () {
        const store = createStore();
        store.selectVersion("unknown", "v1.0.0");
        expect(store.getState().apps.length).toBe(0);
    });

    test("setUpdate ignores unknown app", function () {
        const store = createStore();
        store.setUpdate("unknown", {
            version: "v1.0.0",
            publishedAt: "2024-01-01T00:00:00Z",
            releaseNotes: "",
            assets: []
        });
        expect(store.getState().apps.length).toBe(0);
    });

    test("setLoading ignores unknown app", function () {
        const store = createStore();
        store.setLoading("unknown");
        expect(store.getState().apps.length).toBe(0);
    });

    test("setError ignores unknown app", function () {
        const store = createStore();
        store.setError("unknown", "error");
        expect(store.getState().apps.length).toBe(0);
    });

    test("setSelectedApp updates selected app", function () {
        const store = createStore();
        store.setSelectedApp("randmatqugea");
        expect(store.getState().selectedAppName).toBe("randmatqugea");
    });

    test("subscribe unsubscribe stops notifications", function () {
        const store = createStore();
        let calls = 0;
        const unsubscribe = store.subscribe(function () {
            calls = calls + 1;
        });
        unsubscribe();
        store.registerApp("randmatqugea", "RandMatQuGeA");
        expect(calls).toBe(0);
    });

    test("unsubscribe iterates over non-matching listeners", function () {
        const store = createStore();
        let calls1 = 0;
        let calls2 = 0;
        const listener1 = function (): void {
            calls1 = calls1 + 1;
        };
        const listener2 = function (): void {
            calls2 = calls2 + 1;
        };
        store.subscribe(listener1);
        const unsubscribe2 = store.subscribe(listener2);
        unsubscribe2();
        store.registerApp("randmatqugea", "RandMatQuGeA");
        expect(calls1).toBe(1);
        expect(calls2).toBe(0);
    });
});
