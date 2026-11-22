import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

/**
 * Hosts de desenvolvimento/preview aceitos pelo servidor Vite.
 *
 * Antes: `allowedHosts: true`, que aceita QUALQUER `Host` — um site externo
 * podia apontar o DNS para a máquina do dev e ser servido, e o proxy `/mock`
 * ficava acessível por qualquer nome. A lista abaixo cobre os previews do
 * ambiente (domínio `*.e2b.app` e `localhost`) sem abrir para a internet
 * inteira; `PRIME_DEV_ALLOWED_HOSTS` (lista separada por vírgula) acrescenta
 * hosts extras para quem precisar.
 */
function devAllowedHosts(): string[] {
  const extra = (process.env.PRIME_DEV_ALLOWED_HOSTS ?? '')
    .split(',')
    .map((value) => value.trim())
    .filter((value) => value.length > 0);
  return ['localhost', '127.0.0.1', '.localhost', '.e2b.app', '.e2b.dev', ...extra];
}

export default defineConfig({
  plugins: [react()],
  server: {
    host: '0.0.0.0',
    allowedHosts: devAllowedHosts(),
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
    allowedHosts: devAllowedHosts(),
  },
});
