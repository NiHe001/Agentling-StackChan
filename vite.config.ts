import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import { resolve } from "node:path";

export default defineConfig({
  root: resolve(__dirname, "src/renderer"),
  // Packaged Electron windows load index.html through file://. Relative asset
  // URLs work in both that environment and the Vite development server.
  base: "./",
  plugins: [react()],
  build: {
    outDir: resolve(__dirname, "dist/renderer"),
    emptyOutDir: false,
  },
  test: {
    environment: "node",
    include: [resolve(__dirname, "tests/**/*.test.ts")],
  },
});
