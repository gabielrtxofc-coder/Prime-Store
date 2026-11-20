import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
    host: '0.0.0.0',
    allowedHosts: true,
    // Espelha o mock local de catálogo (`.cache/mock/catalog.mjs`, porta 8787)
    // na mesma origem do dev server: o navegador do preview nunca chama
    // localhost diretamente.
    proxy: {
      '/mock': {
        target: 'http://127.0.0.1:8787',
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/mock/, ''),
      },
    },
  },
  preview: {
    host: '0.0.0.0',
    allowedHosts: true,
  },
});
