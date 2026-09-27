import { defineConfig } from "vite";

// Off by default: with @fastify/static serving dist/public with no deny rules, a source map in
// the output is world-readable and hands out the full original TypeScript, including the exact
// markdown and sanitiser configuration. Set SOURCEMAP=true to opt in for local debugging.
const sourcemap = process.env.SOURCEMAP === "true";

export default defineConfig({
    build: {
        outDir: "dist/public",
        emptyOutDir: true,
        sourcemap: sourcemap,
        minify: true,
        // ES6 is the floor for the shipped bundle, matching the browser tsconfig's target. Vite
        // defaults to a much newer target, which quietly lets syntax that older Safari and older
        // Android WebView cannot parse reach production.
        target: "es6",
        rollupOptions: {
            output: {
                entryFileNames: "assets/[name]-[hash].js",
                chunkFileNames: "assets/[name]-[hash].js",
                assetFileNames: "assets/[name]-[hash][extname]"
            }
        }
    },
    publicDir: "public"
});
