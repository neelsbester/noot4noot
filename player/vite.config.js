import { defineConfig } from 'vite';

export default defineConfig({
  server: {
    port: 5173,
    host: true, // Allow access from other devices on network
    allowedHosts: ['hitster.bestermedia.me'] // Allow Cloudflare Tunnel domain
  },
  build: {
    outDir: 'dist'
  },
  // Handle SPA routing - serve index.html for all routes
  appType: 'spa'
});
