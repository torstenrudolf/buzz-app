import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

const root = fileURLToPath(new URL(".", import.meta.url));

export default defineConfig({
  plugins: [
    react(),
    {
      name: "design-system-boundary",
      generateBundle() {
        const allowed = [
          `${root}src/shared/design-system/`,
          `${root}tests/fixtures/design-system/`,
          `${root}tests/fixtures/design-system.html`,
        ];
        const forbidden = [...this.getModuleIds()].filter(
          (id) =>
            id.startsWith(root) &&
            !id.includes("/node_modules/") &&
            !allowed.some((prefix) => id.startsWith(prefix)),
        );
        if (forbidden.length)
          this.error(
            `Viewer imported non-design source:\n${forbidden.join("\n")}`,
          );
      },
    },
  ],
  publicDir: false,
  base: "./",
  server: {
    port: 1442,
    strictPort: true,
    open: "/tests/fixtures/design-system.html",
  },
  preview: { port: 1443, strictPort: true },
  build: {
    outDir: "dist/design-system",
    emptyOutDir: true,
    sourcemap: false,
    rollupOptions: {
      input: [
        "tests/fixtures/design-system.html",
        "tests/fixtures/design-system/thinking-avatar.html",
      ],
    },
  },
});
