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
  };
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
