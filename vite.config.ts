import { defineConfig } from "vite";

// Tauri forventer fast port og ingen tømming av skjermen under utvikling.
export default defineConfig({
  clearScreen: false,
  server: { port: 1420, strictPort: true },
  envPrefix: ["VITE_", "TAURI_ENV_"],
  // Egen, tom PostCSS-konfig: ellers leter Vite oppover og finner
  // faglederapp sitt Tailwind-oppsett i rotmappa.
  css: { postcss: {} },
  build: {
    target: "es2022",
    chunkSizeWarningLimit: 2000,
  },
});
