import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      // Local dev: forward API calls to the NestJS app
      "/api": "http://localhost:3000",
    },
  },
});
