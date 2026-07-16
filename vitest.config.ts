import { defineConfig } from "vitest/config";

export default defineConfig({
    test: {
        globals: false,
        environment: "happy-dom",
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
            exclude: ["src/public/styles/**", "src/server/main.ts", "src/public/index.ts"]
        }
    }
});
