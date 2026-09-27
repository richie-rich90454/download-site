import { defineConfig } from "vitest/config";

export default defineConfig({
    test: {
        globals: false,
        environment: "happy-dom",
        testTimeout: 15000,
        coverage: {
            provider: "v8",
            reporter: ["text", "json", "html"],
            thresholds: {
                lines: 100,
                branches: 100,
                functions: 100,
                statements: 100
            },
            include: ["src/**/*"],
            exclude: ["src/server/main.ts"]
        }
    }
});
