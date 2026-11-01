/** Acesso a variáveis de ambiente compatível com Deno e Node (testes). */

interface DenoLike {
  env?: { get(key: string): string | undefined };
}

function readEnv(key: string): string | undefined {
  const deno = (globalThis as { Deno?: DenoLike }).Deno;
  if (deno?.env?.get) {
    return deno.env.get(key);
  }
  const processValue = (globalThis as { process?: { env?: Record<string, string | undefined> } })
    .process?.env?.[key];
  return processValue;
}

export interface AppConfig {
  supabaseUrl: string;
  serviceRoleKey: string;
  anonKey: string;
  mercadoPagoAccessToken: string | null;
  mercadoPagoWebhookSecret: string | null;
  mercadoPagoApiBase: string;
  encryptionKey: string | null;
  storeUrl: string;
  paymentNotificationUrl: string | null;
  /**
   * Modo de pagamento demonstrativo (sandbox).
   *
   * Só é considerado ativo quando `DEMO_PAYMENT_ENABLED=true` **e** o projeto
   * Supabase está na lista `DEMO_ALLOWED_PROJECT_REFS`. É uma decisão por
   * ambiente: nunca deve ser habilitado em produção.
   */
  demoPaymentEnabled: boolean;
  demoAllowedProjectRefs: string[];
  /**
   * Origens autorizadas a chamar as Edge Functions pelo navegador (CORS).
   *
   * Vem de `ALLOWED_ORIGINS` (lista separada por vírgula) somada à origem de
   * `STORE_URL`. Sem lista configurada, nenhuma origem cruzada é liberada —
   * o padrão é fechar, não abrir.
   */
  allowedOrigins: string[];
  /**
   * Segredo usado para pseudonimizar a origem do cliente nos contadores de
   * limite de requisições (HMAC). Nunca vai ao navegador. Quando ausente, o
   * sujeito é derivado do `serviceRoleKey` (que só existe no servidor).
   */
  rateLimitSecret: string | null;
  /**
   * Ajuste fino por rota, em requisições por janela de 60s.
   * Formato: `catalog=200,create-order=15`. Serve para calibrar o limite com o
   * tráfego real; não permite desligar a proteção.
   */
  rateLimitOverrides: Record<string, number>;
}

/** `catalog=200,create-order=15` -> `{ catalog: 200, 'create-order': 15 }`. */
export function parseRateLimitOverrides(raw: string): Record<string, number> {
  const result: Record<string, number> = {};
  for (const entry of raw.split(',')) {
    const [rawKey, rawValue] = entry.split('=');
    const key = rawKey?.trim();
    const value = Number(rawValue);
    if (!key || !Number.isInteger(value) || value < 1 || value > 100000) continue;
    result[key] = value;
  }
  return result;
}

export function loadConfig(overrides: Partial<AppConfig> = {}): AppConfig {
  const supabaseUrl = overrides.supabaseUrl ?? readEnv('SUPABASE_URL') ?? '';
  const serviceRoleKey =
    overrides.serviceRoleKey ??
    readEnv('SUPABASE_SERVICE_ROLE_KEY') ??
    readEnv('SUPABASE_SECRET_KEY') ??
    '';

  return {
    supabaseUrl,
    serviceRoleKey,
    anonKey: overrides.anonKey ?? readEnv('SUPABASE_ANON_KEY') ?? readEnv('SUPABASE_PUBLISHABLE_KEY') ?? '',
    mercadoPagoAccessToken:
      overrides.mercadoPagoAccessToken ?? readEnv('MP_ACCESS_TOKEN') ?? null,
    mercadoPagoWebhookSecret:
      overrides.mercadoPagoWebhookSecret ?? readEnv('MP_WEBHOOK_SECRET') ?? null,
    mercadoPagoApiBase:
      overrides.mercadoPagoApiBase ?? readEnv('MP_API_BASE_URL') ?? 'https://api.mercadopago.com',
    encryptionKey: overrides.encryptionKey ?? readEnv('PRIME_ENCRYPTION_KEY') ?? null,
    storeUrl: overrides.storeUrl ?? readEnv('STORE_URL') ?? 'http://localhost:5173',
    paymentNotificationUrl: overrides.paymentNotificationUrl ?? readEnv('MP_NOTIFICATION_URL') ?? null,
    demoPaymentEnabled:
      overrides.demoPaymentEnabled ?? (readEnv('DEMO_PAYMENT_ENABLED') ?? '').trim().toLowerCase() === 'true',
    allowedOrigins:
      overrides.allowedOrigins ??
      (readEnv('ALLOWED_ORIGINS') ?? '')
        .split(',')
        .map((value) => value.trim())
        .filter((value) => value.length > 0),
    rateLimitSecret: overrides.rateLimitSecret ?? readEnv('RATE_LIMIT_SECRET') ?? null,
    rateLimitOverrides:
      overrides.rateLimitOverrides ??
      parseRateLimitOverrides(readEnv('RATE_LIMIT_OVERRIDES') ?? ''),
    demoAllowedProjectRefs:
      overrides.demoAllowedProjectRefs ??
      (readEnv('DEMO_ALLOWED_PROJECT_REFS') ?? 'eorlmqolbknrplvdbbtl')
        .split(',')
        .map((value) => value.trim())
        .filter((value) => value.length > 0),
  };
}

/** Referência do projeto Supabase a partir da URL (ex.: `abc.supabase.co`). */
export function projectRefFromUrl(supabaseUrl: string): string | null {
  try {
    const host = new URL(supabaseUrl).hostname;
    const [ref] = host.split('.');
    return ref || null;
  } catch {
    return null;
  }
}

/**
 * O modo demonstrativo só funciona no projeto de sandbox explicitamente
 * autorizado. Qualquer outro projeto responde como se o modo não existisse.
 */
export function isDemoSandboxAllowed(config: AppConfig): boolean {
  if (!config.demoPaymentEnabled) return false;
  const ref = projectRefFromUrl(config.supabaseUrl);
  return Boolean(ref && config.demoAllowedProjectRefs.includes(ref));
}

/** Configuração mínima para falar com o banco. */
export function requireDatabaseConfig(config: AppConfig): { url: string; serviceRoleKey: string } {
  if (!config.supabaseUrl || !config.serviceRoleKey) {
    throw new Error('supabase_not_configured');
  }
  return { url: config.supabaseUrl, serviceRoleKey: config.serviceRoleKey };
}

/** O pagamento só é habilitado quando há token do Mercado Pago configurado. */
export function requireMercadoPago(config: AppConfig): string {
  if (!config.mercadoPagoAccessToken) {
    throw new Error('payment_not_configured');
  }
  return config.mercadoPagoAccessToken;
}

export function requireEncryptionKey(config: AppConfig): string {
  if (!config.encryptionKey) {
    throw new Error('encryption_not_configured');
  }
  return config.encryptionKey;
}
