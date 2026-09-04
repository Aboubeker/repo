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
    /*
     * Source maps activées en production.
     *
     * Sans elles, un rapport d'erreur ne contient que des noms minifiés :
     * « TypeError: r is not a function » suivi d'une pile en `Di / Ir / Kn`,
     * strictement inexploitable. Le diagnostic d'un incident signalé par la
     * clinique passait de quelques minutes à plusieurs heures de recherche
     * à l'aveugle.
     *
     * Le déploiement étant local et hors ligne, aucun code n'est exposé à
     * l'extérieur : l'argument habituel contre les source maps en production
     * ne s'applique pas ici. Les fichiers .map ne sont téléchargés par le
     * navigateur que si les outils de développement sont ouverts.
     */
    sourcemap: true,
    chunkSizeWarningLimit: 900,
  },
});
