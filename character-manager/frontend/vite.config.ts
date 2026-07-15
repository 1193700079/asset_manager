import { defineConfig } from "vite"
import react from "@vitejs/plugin-react"

const proxy = {
  "/api": { target: "http://localhost:8889", changeOrigin: true },
}

export default defineConfig({
  plugins: [react()],
  server: {
    port: 8888,
    host: "0.0.0.0",
    allowedHosts: ["cm.priya-ai.online"],
    proxy,
  },
  preview: {
    port: 8888,
    host: "0.0.0.0",
    strictPort: true,
    allowedHosts: ["cm.priya-ai.online"],
    proxy,
  },
})
