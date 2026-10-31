/**
 * Configuração do backend (Supabase) exposta ao frontend.
 *
 * Somente valores públicos entram no bundle: URL do projeto e chave `anon`.
 * A chave `service_role` NUNCA é referenciada aqui.
 *
 * O modo backend precisa ser habilitado explicitamente com
 * `VITE_BACKEND_ENABLED=true`; sem isso a aplicação roda no modo de
 * demonstração local (nenhuma requisição de rede).
 */

export interface BackendConfig {
  /** true somente quando a flag está ligada e URL + chave anon existem. */
  enabled: boolean;
  supabaseUrl: string | null;
  anonKey: string | null;
  /** Base das Edge Functions (sem barra final). */
  functionsUrl: string | null;
}

function readEnv(): Record<string, string | undefined> {
  const meta = import.meta as unknown as { env?: Record<string, string | undefined> };
  return meta.env ?? {};
}

const trimUrl = (value: string | undefined): string | null => {
  const trimmed = (value ?? '').trim().replace(/\/+$/, '');
  return trimmed.length > 0 ? trimmed : null;
};

export function getBackendConfig(): BackendConfig {
  const env = readEnv();
  const supabaseUrl = trimUrl(env.VITE_SUPABASE_URL);
  const anonKey = (env.VITE_SUPABASE_ANON_KEY ?? '').trim() || null;
  const explicitFunctionsUrl = trimUrl(env.VITE_BACKEND_URL);
  const functionsUrl = explicitFunctionsUrl ?? (supabaseUrl ? `${supabaseUrl}/functions/v1` : null);
  const flag = (env.VITE_BACKEND_ENABLED ?? '').trim().toLowerCase();
  const flagOn = flag === 'true' || flag === '1';
  const enabled = flagOn && Boolean(supabaseUrl && anonKey && functionsUrl);

  return { enabled, supabaseUrl, anonKey, functionsUrl };
}

/** Erro de configuração que deve virar mensagem de interface, não crash. */
export function assertBackendConfigured(): { supabaseUrl: string; anonKey: string; functionsUrl: string } {
  const config = getBackendConfig();
  if (!config.enabled || !config.supabaseUrl || !config.anonKey || !config.functionsUrl) {
    throw new Error('backend_not_configured');
  }
  return {
    supabaseUrl: config.supabaseUrl,
    anonKey: config.anonKey,
    functionsUrl: config.functionsUrl,
  };
}
