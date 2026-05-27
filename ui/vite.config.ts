import path from "path";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { createUiDevWatchOptions } from "./src/lib/vite-watch";

export default defineConfig(({ mode }) => ({
  // Wave 7 PR-6 (Infrakaihatsu embed): when building for the embedded
  // admin surface at https://infrakaihatsu.com/admin/paperclip/, set
  // PAPERCLIP_EMBED_BASE=/admin/paperclip/ so Vite emits HTML/asset
  // references under that prefix. Default "/" preserves standalone-
  // Paperclip behavior.
  //
  // Pair this with VITE_API_BASE (read by ui/src/lib/api-base.ts) so
  // REST + WebSocket calls go through the same prefix. They must move
  // together — see Infrakaihatsu's
  // `.workflow/WAVE7_PR6_PAPERCLIP_PREFIX_NOTES.md`.
  base: process.env.PAPERCLIP_EMBED_BASE ?? "/",
  plugins: [react(), tailwindcss()],
  build: {
    minify: "esbuild",
  },
  esbuild:
    mode === "production"
      ? {
          drop: ["console", "debugger"],
          legalComments: "none",
        }
      : undefined,
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
      lexical: path.resolve(__dirname, "./node_modules/lexical/Lexical.mjs"),
    },
  },
  server: {
    port: 5173,
    watch: createUiDevWatchOptions(process.cwd()),
    proxy: {
      "/api": {
        target: "http://localhost:3100",
        ws: true,
      },
    },
  },
}));
