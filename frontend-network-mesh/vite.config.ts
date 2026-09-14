import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// All /api traffic (including the SSE stream) goes to the backend control plane.
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      "/api": { target: "http://127.0.0.1:7070" },
    },
  },
});
