import { defineConfig } from "vite";

export default defineConfig({
  root: ".",
  publicDir: "public",
  appType: "spa",
  build: {
    outDir: "dist",
    emptyOutDir: true,
  },
  server: {
    middlewareMode: true,
    hmr: false,
  },
});
