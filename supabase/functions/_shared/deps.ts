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
  fetchImpl: typeof fetch;
  now: () => Date;
  log: (event: string, meta?: Record<string, unknown>) => void;
}

export interface CreateDepsOverrides {
  config?: Partial<AppConfig>;
  rpc?: RpcFn;
  rpcForUser?: (authorization: string) => RpcFn;
  fetchImpl?: typeof fetch;
  now?: () => Date;
  log?: (event: string, meta?: Record<string, unknown>) => void;
  /** JWT do usuário; usado apenas pela API administrativa. */
  authorization?: string;
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

  return {
    config,
    rpc,
    rpcForUser,
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
