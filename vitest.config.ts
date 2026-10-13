import { defineConfig } from "vitest/config";

export default defineConfig({
    test: {
        globals: false,
        environment: "happy-dom",
        // Generous on purpose. The disk-cache suite performs ~400 asynchronous filesystem
        // operations per run, and on a loaded Windows box a single file creation can stall for
        // over a minute before the OS completes it - the operation does finish, it is just slow.
        // A 15s ceiling turned that into a timeout that landed on a different test each run, while
        // a 5 minute ceiling lets the slow-but-successful run pass and still catches a true wedge.
        testTimeout: 300000,
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
