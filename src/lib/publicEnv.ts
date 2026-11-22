/**
 * Leitura das variáveis públicas do build (Vite).
 *
 * Só valores públicos (`VITE_*`) passam por aqui; nenhuma chave privilegiada é
 * lida no navegador.
 *
 * Duas origens, por motivos concretos:
 *  - `import.meta.env`: é o que o Vite injeta no bundle. **O acesso precisa ser
 *    literal** — o Vite só substitui o padrão `(import.meta).env`. Guardar
 *    `import.meta` numa variável e ler `.env` depois faz a loja receber
 *    `undefined` e cair silenciosamente no catálogo local.
 *  - `process.env`: existe apenas em Node (testes de unidade). Em `vi.stubEnv`
 *    o valor é aplicado ao ambiente do processo; sem esse caminho, o objeto já
 *    congelado no build mascararia o valor do teste.
 *
 * No navegador `process` não existe, então vale só o objeto do build.
 *
 * SOMENTE `VITE_*`: antes o objeto de `process.env` era espalhado inteiro no
 * resultado. Em qualquer runtime que exponha `process.env` (por exemplo, um
 * empacotador próprio que faça shim de `process`), uma flag pública como
 * `VITE_ADMIN_DEMO` podia ser respondida por variável de ambiente do servidor,
 * e chaves não-`VITE_` ficavam legíveis por este helper. A lista de permissão
 * fecha os dois casos: valor público só entra por nome público.
 */
export type PublicEnv = Record<string, string | undefined>;

const PUBLIC_PREFIX = 'VITE_';

function publicEntries(source: PublicEnv | undefined): PublicEnv {
  const result: PublicEnv = {};
  if (!source) return result;
  for (const [key, value] of Object.entries(source)) {
    if (key.startsWith(PUBLIC_PREFIX)) result[key] = value;
  }
  return result;
}

export function readPublicEnv(): PublicEnv {
  const buildEnv = (import.meta as unknown as { env?: PublicEnv }).env ?? {};
  const nodeEnv =
    typeof globalThis !== 'undefined' && 'process' in globalThis
      ? (globalThis as { process?: { env?: PublicEnv } }).process?.env
      : undefined;
  return nodeEnv ? { ...publicEntries(buildEnv), ...publicEntries(nodeEnv) } : buildEnv;
}

/** Valor textual normalizado (vazio quando ausente). */
export function readEnvValue(name: string): string {
  return (readPublicEnv()[name] ?? '').trim();
}

/** Flag booleana pública: aceita `true` ou `1`. */
export function readEnvFlag(name: string): boolean {
  const value = readEnvValue(name).toLowerCase();
  return value === 'true' || value === '1';
}
