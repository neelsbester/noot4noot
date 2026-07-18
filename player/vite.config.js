import { defineConfig, loadEnv } from 'vite';

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '');
  const allowedHosts = [
    'localhost',
    '127.0.0.1',
    ...(env.VITE_ALLOWED_HOSTS || '')
      .split(',')
      .map(host => host.trim())
  ].filter(Boolean);

  return {
    server: {
      port: 5173,
      host: true, // Allow access from other devices on network
      allowedHosts
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
  };
});
