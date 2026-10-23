import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";
export default defineConfig({
  root: fileURLToPath(new URL(".", import.meta.url)),
  plugins: [react()],
  server: {
    host: "127.0.0.1",
    port: 8921,
    strictPort: true,
    proxy: Object.fromEntries(
      ["/admin", "/auth", "/health", "/v1"].map((p) => [
        p,
        "http://127.0.0.1:8920",
      ]),
    ),
  },
  build: { outDir: "dist", emptyOutDir: true },
});
