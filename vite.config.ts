import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig(({ command, mode }) => {
  const environment = loadEnv(mode, process.cwd(), "VITE_");
  if (command === "build" && !(process.env.VITE_FIREBASE_API_KEY ?? environment.VITE_FIREBASE_API_KEY)?.trim()) {
    throw new Error("Full builds require VITE_FIREBASE_API_KEY. Configure .env.local, or use npm run build:demo for the public-source demo.");
  }
  return {
    plugins: [react()],
    server: {
      host: "127.0.0.1", port: 5173, strictPort: true,
      watch: { ignored: ["**/.data/**", "**/.playwright-mcp/**"] },
    },
    preview: { host: "127.0.0.1", port: 4173, strictPort: true },
    build: { sourcemap: false },
  };
});
