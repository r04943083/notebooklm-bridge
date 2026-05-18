import path from "node:path";
import { fileURLToPath } from "node:url";
import { readFileSync } from "node:fs";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const srcDir = path.resolve(__dirname, "./src");

// Bake package.json's `version` into the build so the footer shows it without
// drift. `import pkg from "./package.json" with { type: "json" }` would be
// cleaner but trips TS5 default isolated-modules; reading JSON manually keeps
// vite.config.ts portable.
const pkgVersion: string = JSON.parse(
  readFileSync(path.resolve(__dirname, "./package.json"), "utf-8"),
).version;

// Port pinning is a HARD requirement, see CLAUDE.md §3.2. strictPort: true makes
// the dev server fail loudly instead of silently bumping to 5176, which would
// break the documented proxy / CORS / readme URLs.
export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      "@": srcDir,
    },
  },
  define: {
    __APP_VERSION__: JSON.stringify(pkgVersion),
  },
  server: {
    host: "0.0.0.0",
    port: 5175,
    strictPort: true,
    proxy: {
      "/api": "http://localhost:8002",
    },
  },
});
