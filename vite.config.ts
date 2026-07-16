import { defineConfig } from "vite";

export default defineConfig({
    build: {
        outDir: "dist/public",
        emptyOutDir: true,
        sourcemap: true,
        minify: true,
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
