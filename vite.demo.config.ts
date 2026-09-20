import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { assertSafeDirectory } from "./tools/web/bank.js";

export default defineConfig({
  plugins: [
    react(),
    {
      name: "isolated-demo-output",
      async configResolved(config) {
        await assertSafeDirectory(config.root, ".data/demo/public");
        await assertSafeDirectory(config.root, "dist-demo");
      },
    },
  ],
  publicDir: ".data/demo/public",
  define: { "import.meta.env.VITE_STUDY_DEMO": JSON.stringify("true") },
  server: {
    host: "127.0.0.1", port: 5174, strictPort: true,
    watch: { ignored: ["**/.data/**", "**/.playwright-mcp/**"] },
  },
  preview: { host: "127.0.0.1", port: 4174, strictPort: true },
  build: { outDir: "dist-demo", emptyOutDir: true, sourcemap: false },
});
