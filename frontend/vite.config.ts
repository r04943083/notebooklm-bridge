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

// Port behaviour, see CLAUDE.md §3.2. Both ports are passed in by
// scripts/start-web.sh AFTER it has probed the system for free ports (auto-
// incrementing up to 10 times). vite itself stays strictPort: true so it
// never silently bumps to 5176 — probing is the shell script's job, and we
// want the dev-server's bind to either succeed at the requested port or
// crash loudly so the supervisor's log makes the misconfig visible.
const backendPort = process.env.VITE_BACKEND_PORT ?? "8002";
const frontendPort = Number(process.env.VITE_PORT ?? 5175);

// WSL2 quirk: when the working tree lives under `/mnt/<drive>/...`, the 9P
// Windows↔Linux file bridge unreliably emits inotify events, so chokidar
// (Vite's default watcher) misses file edits — HMR silently drops, and a
// hard browser refresh just re-serves the cached bundle. Switching to
// polling on these mounts is the well-known fix; CPU cost is negligible at
// a 300ms interval. Native Linux paths skip this so we don't waste cycles.
const onWslMount = process.cwd().startsWith("/mnt/");

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
    port: frontendPort,
    strictPort: true,
    proxy: {
      "/api": `http://localhost:${backendPort}`,
    },
    watch: onWslMount
      ? { usePolling: true, interval: 300 }
      : undefined,
  },
});
