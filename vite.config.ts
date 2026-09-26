import { defineConfig } from "vite";

// Tauri forventer fast port og ingen tømming av skjermen under utvikling.
export default defineConfig({
  clearScreen: false,
  server: { port: 1420, strictPort: true },
  envPrefix: ["VITE_", "TAURI_ENV_"],
  build: {
    target: "es2022",
    chunkSizeWarningLimit: 2000,
  },
});
