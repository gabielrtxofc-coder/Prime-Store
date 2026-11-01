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
 */
export type PublicEnv = Record<string, string | undefined>;

export function readPublicEnv(): PublicEnv {
  const buildEnv = (import.meta as unknown as { env?: PublicEnv }).env ?? {};
  const nodeEnv =
    typeof globalThis !== 'undefined' && 'process' in globalThis
      ? (globalThis as { process?: { env?: PublicEnv } }).process?.env
      : undefined;
  return nodeEnv ? { ...buildEnv, ...nodeEnv } : buildEnv;
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
