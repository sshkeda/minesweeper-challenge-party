import path from "node:path";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: { alias: { "@": path.resolve(__dirname, "./src") } },
  server: {
    port: 5173,
    allowedHosts: true,
    proxy: {
      "/api": "http://localhost:4321",
      "/ws": { target: "ws://localhost:4321", ws: true },
    },
  },
});
