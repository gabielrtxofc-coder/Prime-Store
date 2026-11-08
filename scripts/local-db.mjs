/**
 * PostgreSQL local para a suíte de testes (SOMENTE DESENVOLVIMENTO).
 *
 * Por que existe: a suíte de banco (`npm run test:db`) recria o schema a partir
 * das migrações em um PostgreSQL real. Em ambientes sem servidor instalado
 * (containers de CI, sandboxes) ela não tinha onde rodar, e a verificação de
 * RLS, estoque, idempotência e privilégios ficava sem execução.
 *
 * `embedded-postgres` é uma **devDependency**: baixa um binário do PostgreSQL e
 * o executa localmente. Nada disso entra no bundle do frontend, nas Edge
 * Functions ou no runtime de produção — o site não importa este pacote.
 *
 * Uso:
 *   node scripts/local-db.mjs start   # sobe e imprime a DATABASE_URL
 *   node scripts/local-db.mjs stop    # derruba
 *   node scripts/local-db.mjs status  # verifica se está no ar
 *
 * Variáveis: PGPORT (padrão 55432), PGDATA_DIR (padrão /tmp/prime-store-pgdata).
 */

import EmbeddedPostgres from 'embedded-postgres';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export const DEFAULT_PORT = Number(process.env.PGPORT ?? 55432);
export const DEFAULT_DATA_DIR = process.env.PGDATA_DIR ?? '/tmp/prime-store-pgdata';
/** URL consumida por `tests/db/helpers.ts` (via variável de ambiente). */
export const DATABASE_URL = `postgresql://postgres:postgres@127.0.0.1:${DEFAULT_PORT}/postgres`;

const options = {
  databaseDir: DEFAULT_DATA_DIR,
  user: 'postgres',
  password: 'postgres',
  port: DEFAULT_PORT,
  persistent: true,
  // `C` mantém ordenação previsível nos testes; UTF8 preserva acentos dos dados.
  initdbFlags: ['--encoding=UTF8', '--locale=C'],
};

function isListening(port) {
  return new Promise((resolve) => {
    const socket = net.connect({ host: '127.0.0.1', port }, () => {
      socket.destroy();
      resolve(true);
    });
    socket.on('error', () => resolve(false));
    socket.setTimeout(1000, () => {
      socket.destroy();
      resolve(false);
    });
  });
}

async function start() {
  if (await isListening(DEFAULT_PORT)) {
    console.log(`[local-db] já em execução em 127.0.0.1:${DEFAULT_PORT}`);
    console.log(`DATABASE_URL=${DATABASE_URL}`);
    return;
  }

  const pg = new EmbeddedPostgres(options);
  await pg.initialise();
  await pg.start();
  console.log(`[local-db] PostgreSQL iniciado em 127.0.0.1:${DEFAULT_PORT}`);
  console.log(`[local-db] dados em ${DEFAULT_DATA_DIR}`);
  console.log(`DATABASE_URL=${DATABASE_URL}`);
  console.log('[local-db] deixando em segundo plano; use "node scripts/local-db.mjs stop" para encerrar.');
  // Não derruba o processo: o servidor precisa continuar vivo para os testes.
  // A porta é liberada pelo comando `stop` (ou quando o container cai).
  await new Promise(() => {});
}

async function stop() {
  const pg = new EmbeddedPostgres(options);
  try {
    await pg.stop();
    console.log('[local-db] encerrado');
  } catch (error) {
    console.log(`[local-db] nada para encerrar (${error instanceof Error ? error.message : 'erro'})`);
  }
}

async function status() {
  const up = await isListening(DEFAULT_PORT);
  console.log(up ? `[local-db] no ar em 127.0.0.1:${DEFAULT_PORT}` : '[local-db] parado');
  if (up) console.log(`DATABASE_URL=${DATABASE_URL}`);
  process.exitCode = up ? 0 : 1;
}

const command = process.argv[2] ?? 'start';
if (command === 'start') await start();
else if (command === 'stop') await stop();
else if (command === 'status') await status();
else {
  console.error(`comando desconhecido: ${command}`);
  process.exitCode = 2;
}

export { ROOT };
