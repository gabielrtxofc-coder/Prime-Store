import { defineConfig } from 'vitest/config';

/**
 * Suíte do frontend (jsdom). Os testes de banco/back-end ficam em `tests/` e
 * rodam com `vitest.db.config.ts`, porque exigem um PostgreSQL real:
 *   npm test        -> frontend
 *   npm run test:db -> banco + unitários
 *   npm run test:all-> tudo
 */
export default defineConfig({
  // Os testes precisam ser herméticos: `envDir` aponta para uma pasta sem
  // arquivos .env, então o `.env.local` de desenvolvimento (backend ligado,
  // painel demonstrativo ligado) não vaza para as asserções de configuração.
  envDir: './tests/env-isolated',
  test: {
    environment: 'jsdom',
    setupFiles: ['./src/test/setup.ts'],
    clearMocks: true,
    include: ['src/**/*.test.{ts,tsx}'],
  },
});
