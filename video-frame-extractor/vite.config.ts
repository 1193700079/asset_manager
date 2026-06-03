import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  server: {
    host: '0.0.0.0',
    port: 8898,
    strictPort: true,
    proxy: {
      // Forward catalogue + streaming requests to the local Node server.
      '/api': {
        target: 'http://localhost:8899',
        changeOrigin: false,
        // AI analysis can take up to 5 minutes; disable proxy timeout.
        timeout: 300000,
        proxyTimeout: 300000,
      },
    },
  },
  build: {
    rollupOptions: {
      output: {
        entryFileNames: `assets/[name].js`,
        chunkFileNames: `assets/[name].js`,
        assetFileNames: `assets/[name].[ext]`
      }
    }
  },
  base: "",

})
