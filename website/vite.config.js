import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  build: {
    target: "es2020",
    chunkSizeWarningLimit: 1200, // maplibre-gl is one large chunk, loaded only when the demo comes into view
    rollupOptions: {
      output: {
        manualChunks: { maplibre: ["maplibre-gl"] },
      },
    },
  },
});
