import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [react()],
  server: { port: 5173, proxy: { '/api': 'http://127.0.0.1:8080' } },
  preview: { port: 4173, proxy: { '/api': 'http://127.0.0.1:8080' } },
  build: { target: 'es2022', sourcemap: false, chunkSizeWarningLimit: 900, assetsInlineLimit: 0 }, // no data: URIs (CSP font-src 'self')
});
