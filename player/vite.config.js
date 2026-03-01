import { defineConfig } from 'vite';

export default defineConfig({
  server: {
    port: 5173,
    host: true, // Allow access from other devices on network
    allowedHosts: [process.env.VITE_ALLOWED_HOST || 'localhost']
  },
  build: {
    outDir: 'dist',
    target: 'es2020',
    sourcemap: false,
    rollupOptions: {
      output: {
        manualChunks: {
          vendor: ['html5-qrcode', 'jsqr']
        }
      }
    }
  },
  // Handle SPA routing - serve index.html for all routes
  appType: 'spa'
});
