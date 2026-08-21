import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '');
  return {
    plugins: [react()],
    build: {
      outDir: 'dist',
    },
    server: {
      proxy: {
        // Local dev only: forwards /api calls to the Functions host / SWA CLI.
        // Override with VITE_API_PROXY_TARGET in .env.local if your host runs elsewhere.
        '/api': env.VITE_API_PROXY_TARGET || 'http://localhost:7071',
      },
    },
  };
});
