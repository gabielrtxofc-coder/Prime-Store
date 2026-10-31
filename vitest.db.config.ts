import { defineConfig } from 'vitest/config';

/**
 * Suíte de integração com PostgreSQL real.
 * Requer DATABASE_URL apontando para um Postgres local (ver scripts/local-db.sh).
 * Roda em um único processo: os testes recriam o schema e não podem competir.
 */
export default defineConfig({
  test: {
    include: ['tests/db/**/*.test.ts', 'tests/unit/**/*.test.ts'],
    environment: 'node',
    fileParallelism: false,
    sequence: { concurrent: false },
    testTimeout: 30000,
    hookTimeout: 60000,
  },
});
