import { loadConfig, type AppConfig } from './config.ts';
import { createRpcClient, type RpcFn } from './rest.ts';

export interface Deps {
  config: AppConfig;
  rpc: RpcFn;
  /**
   * Cliente RPC com as claims do usuário (JWT). Obrigatório para a API
   * administrativa, onde auth.uid()/aal precisam da identidade do chamador.
   */
  rpcForUser?: (authorization: string) => RpcFn;
  /** Cliente com a service role (uso restrito: segredos, ciphertext). */
  serviceRpc?: RpcFn;
  fetchImpl: typeof fetch;
  now: () => Date;
  log: (event: string, meta?: Record<string, unknown>) => void;
  /**
   * Chave mestra de criptografia (AES-256-GCM). Preferência: variável de
   * ambiente da função; fallback: segredo no Supabase Vault lido via RPC
   * restrita a service_role. Nunca é enviada ao cliente.
   */
  resolveEncryptionKey: () => Promise<string | null>;
}

export interface CreateDepsOverrides {
  config?: Partial<AppConfig>;
  rpc?: RpcFn;
  rpcForUser?: (authorization: string) => RpcFn;
  serviceRpc?: RpcFn;
  fetchImpl?: typeof fetch;
  now?: () => Date;
  log?: (event: string, meta?: Record<string, unknown>) => void;
  /** JWT do usuário; usado apenas pela API administrativa. */
  authorization?: string;
  resolveEncryptionKey?: () => Promise<string | null>;
}

/**
 * Monta as dependências reais a partir do ambiente. Testes injetam `rpc`,
 * `fetchImpl` e `config` para exercitar o fluxo sem rede.
 */
export function createDeps(overrides: CreateDepsOverrides = {}): Deps {
  const config = loadConfig(overrides.config ?? {});
  const fetchImpl = overrides.fetchImpl ?? fetch;

  const rpc =
    overrides.rpc ??
    createRpcClient({
      url: config.supabaseUrl,
      apiKey: config.serviceRoleKey,
      authorization: overrides.authorization,
      fetchImpl,
    });

  const rpcForUser =
    overrides.rpcForUser ??
    ((authorization: string) =>
      createRpcClient({
        url: config.supabaseUrl,
        apiKey: config.anonKey || config.serviceRoleKey,
        authorization,
        fetchImpl,
      }));

  // Cache por instância (uma por isolate): evita um RPC por requisição.
  let vaultKeyCache: string | null | undefined;

  const resolveEncryptionKey =
    overrides.resolveEncryptionKey ??
    (async (): Promise<string | null> => {
      if (config.encryptionKey) return config.encryptionKey;
      if (vaultKeyCache !== undefined) return vaultKeyCache;

      try {
        const secret = await rpc<string | null>('get_secret_material', {
          p_name: 'prime_store_encryption_key',
        });
        vaultKeyCache = typeof secret === 'string' && secret.length > 0 ? secret : null;
      } catch {
        vaultKeyCache = null;
      }
      return vaultKeyCache;
    });

  return {
    config,
    rpc,
    rpcForUser,
    serviceRpc: rpc,
    resolveEncryptionKey,
    fetchImpl,
    now: overrides.now ?? (() => new Date()),
    log:
      overrides.log ??
      ((event, meta) => {
        // Nunca registrar credenciais, tokens ou e-mails.
        console.log(`[prime-store] ${event}`, meta ? JSON.stringify(meta) : '');
      }),
  };
}
