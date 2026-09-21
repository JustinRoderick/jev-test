import { defineConfig } from "vite-plus";
import { tanstackStart } from "@tanstack/react-start/plugin/vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { varlockVitePlugin } from "@varlock/vite-integration";
import { fileURLToPath } from "node:url";

export default defineConfig({
  plugins: [
    varlockVitePlugin({ ssrInjectMode: "init-only" }),
    tailwindcss(),
    tanstackStart(),
    react(),
  ],
  resolve: { alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) } },
  server: { host: "127.0.0.1", port: 3000 },
  ssr: { external: ["@duckdb/node-api", "@effect/sql-sqlite-node"] },
  optimizeDeps: {
    exclude: [
      "@duckdb/node-api",
      "@duckdb/node-bindings",
      "@effect/sql-sqlite-node",
      "better-sqlite3",
    ],
  },
  test: { include: ["tests/**/*.test.ts"], testTimeout: 30_000 },
  fmt: {
    ignorePatterns: [
      ".references/**",
      ".data/**",
      "src/routeTree.gen.ts",
      "pnpm-lock.yaml",
      "env.d.ts",
    ],
  },
  lint: { ignorePatterns: [".references/**", ".data/**", "src/routeTree.gen.ts", "env.d.ts"] },
});
