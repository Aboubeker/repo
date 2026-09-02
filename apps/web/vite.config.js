import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
    host: '0.0.0.0',
    port: 5173,
    // Autorise l'accès depuis n'importe quel poste du réseau local de la clinique
    // ainsi que depuis l'environnement de prévisualisation.
    allowedHosts: true,
    proxy: {
      // Le navigateur ne joint jamais l'API directement : tout passe par le proxy,
      // ce qui évite toute configuration réseau côté poste client.
      '/api': { target: 'http://127.0.0.1:3001', changeOrigin: true },
    },
  },
  build: {
    outDir: 'dist',
    sourcemap: false,
    chunkSizeWarningLimit: 900,
  },
});
