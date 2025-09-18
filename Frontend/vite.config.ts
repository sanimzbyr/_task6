import { defineConfig } from 'vite'
export default defineConfig({
  server: {
    port: 5173,
    proxy: {
      '/api':  { target: 'http://localhost:5199', changeOrigin: true },
      '/hubs': { target: 'http://localhost:5199', ws: true, changeOrigin: true },
      '/uploads': { target: 'http://localhost:5199', changeOrigin: true }
    }
  }
})
