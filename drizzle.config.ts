import { defineConfig } from "drizzle-kit";

export default defineConfig({
    dialect: "sqlite",
    schema: "./src/server/db/schema/*.ts",
    out: "./drizzle",
    dbCredentials: {
        // Only used by `drizzle-kit generate` to read the existing schema, never to write.
        // Both databases are derived data and are rebuilt on demand, so a throwaway file is
        // enough and there is no production path to point this at.
        url: "./drizzle/.generate-scratch.db"
    },
    strict: true,
    verbose: true
});
