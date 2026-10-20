import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      "/api": "http://localhost:3000",
    },
  },
  build: {
    // No inline <script>/<style>: the CSP forbids them.
    assetsInlineLimit: 0,
    sourcemap: false,
  },
});
