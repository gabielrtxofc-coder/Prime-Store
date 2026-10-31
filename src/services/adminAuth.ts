import { createClient, type Session, type SupabaseClient } from '@supabase/supabase-js';
import { assertBackendConfigured } from './backend/config';
import { invokeFunction } from './backend/http';

/**
 * Autenticação do painel administrativo.
 *
 * - Login por e-mail/senha (Supabase Auth) — cadastro público desativado.
 * - Segunda etapa obrigatória por TOTP (AAL2). O token de sessão sozinho (AAL1)
 *   não autoriza nenhuma ação administrativa.
 * - Nenhuma chave privilegiada é usada no navegador: apenas a chave pública
 *   `anon`, e a autorização real acontece no banco (`assert_admin`).
 */

let client: SupabaseClient | null = null;

export function getSupabaseAuthClient(): SupabaseClient {
  if (client) return client;
  const { supabaseUrl, anonKey } = assertBackendConfigured();
  client = createClient(supabaseUrl, anonKey, {
    auth: {
      persistSession: true,
      autoRefreshToken: true,
      detectSessionInUrl: true,
      storageKey: 'prime-store.admin-auth',
    },
  });
  return client;
}

export interface Ok<T> {
  ok: true;
  value: T;
}
export interface Fail {
  ok: false;
  message: string;
}
export type Result<T> = Ok<T> | Fail;

const fail = (message: string): Fail => ({ ok: false, message });

export interface TotpFactor {
  id: string;
  friendlyName: string | null;
}

export interface AdminSession {
  userId: string;
  email: string | null;
  currentLevel: string;
  nextLevel: string;
  /** Preenchido quando o usuário precisa concluir o TOTP. */
  pendingTotp: boolean;
  factors: TotpFactor[];
  isAdmin: boolean;
  mfaSatisfied: boolean;
}

function translateAuthError(message: string): string {
  const normalized = message.toLowerCase();
  if (normalized.includes('invalid login credentials')) return 'E-mail ou senha inválidos.';
  if (normalized.includes('email not confirmed')) return 'Confirme seu e-mail antes de entrar.';
  if (normalized.includes('invalid totp code') || normalized.includes('invalid code')) {
    return 'Código de verificação inválido. Gere um novo código no aplicativo autenticador.';
  }
  if (normalized.includes('rate limit') || normalized.includes('too many')) {
    return 'Muitas tentativas. Aguarde alguns minutos e tente novamente.';
  }
  return message;
}

async function listTotpFactors(supabase: SupabaseClient): Promise<TotpFactor[]> {
  const { data, error } = await supabase.auth.mfa.listFactors();
  if (error) return [];
  return (data?.totp ?? [])
    .filter((factor) => factor.status === 'verified')
    .map((factor) => ({ id: factor.id, friendlyName: factor.friendly_name ?? null }));
}

async function describeSession(supabase: SupabaseClient, session: Session): Promise<AdminSession> {
  const { data: aal } = await supabase.auth.mfa.getAuthenticatorAssuranceLevel();
  const factors = await listTotpFactors(supabase);
  const currentLevel = aal?.currentLevel ?? 'aal1';
  const nextLevel = aal?.nextLevel ?? currentLevel;

  // A allowlist é decidida pelo banco; aqui só refletimos o resultado.
  let isAdmin = false;
  let mfaSatisfied = false;
  try {
    const status = await adminInvoke<{ is_admin: boolean; mfa_satisfied: boolean }>('session', {}, session.access_token);
    isAdmin = status.is_admin === true;
    mfaSatisfied = status.mfa_satisfied === true;
  } catch {
    isAdmin = false;
    mfaSatisfied = false;
  }

  return {
    userId: session.user.id,
    email: session.user.email ?? null,
    currentLevel,
    nextLevel,
    pendingTotp: currentLevel !== 'aal2' && nextLevel === 'aal2' && factors.length > 0,
    factors,
    isAdmin,
    mfaSatisfied,
  };
}

export async function signInWithPassword(email: string, password: string): Promise<Result<AdminSession>> {
  try {
    const supabase = getSupabaseAuthClient();
    const { data, error } = await supabase.auth.signInWithPassword({
      email: email.trim().toLowerCase(),
      password,
    });
    if (error || !data.session) return fail(translateAuthError(error?.message ?? 'Falha ao entrar.'));
    return { ok: true, value: await describeSession(supabase, data.session) };
  } catch (error) {
    return fail(error instanceof Error ? error.message : 'Falha ao entrar.');
  }
}

export async function getCurrentSession(): Promise<Result<AdminSession | null>> {
  try {
    const supabase = getSupabaseAuthClient();
    const { data } = await supabase.auth.getSession();
    if (!data.session) return { ok: true, value: null };
    return { ok: true, value: await describeSession(supabase, data.session) };
  } catch (error) {
    return fail(error instanceof Error ? error.message : 'Falha ao ler a sessão.');
  }
}

/** Inicia o cadastro de um autenticador TOTP (mostra o QR code). */
export async function startTotpEnrollment(): Promise<Result<{ factorId: string; qrCode: string; secret: string }>> {
  try {
    const supabase = getSupabaseAuthClient();
    const { data, error } = await supabase.auth.mfa.enroll({ factorType: 'totp', friendlyName: 'Prime Store Admin' });
    if (error || !data) return fail(translateAuthError(error?.message ?? 'Falha ao iniciar o TOTP.'));

    if (data.type !== 'totp') return fail('Tipo de fator inesperado.');

    return {
      ok: true,
      value: {
        factorId: data.id,
        qrCode: data.totp.qr_code,
        secret: data.totp.secret,
      },
    };
  } catch (error) {
    return fail(error instanceof Error ? error.message : 'Falha ao iniciar o TOTP.');
  }
}

/** Confirma o código do autenticador e eleva a sessão para AAL2. */
export async function verifyTotp(factorId: string, code: string): Promise<Result<AdminSession>> {
  try {
    const supabase = getSupabaseAuthClient();
    const { error } = await supabase.auth.mfa.challengeAndVerify({
      factorId,
      code: code.replace(/\s+/g, ''),
    });
    if (error) return fail(translateAuthError(error.message));

    const { data } = await supabase.auth.getSession();
    if (!data.session) return fail('Sessão expirada. Entre novamente.');
    return { ok: true, value: await describeSession(supabase, data.session) };
  } catch (error) {
    return fail(error instanceof Error ? error.message : 'Falha ao validar o código.');
  }
}

export async function signOutAdmin(): Promise<void> {
  try {
    await getSupabaseAuthClient().auth.signOut();
  } catch {
    // Sair localmente é suficiente; o servidor invalida o refresh token.
  }
}

/** Envia e-mail de recuperação de senha (sem revelar se a conta existe). */
export async function requestPasswordReset(email: string): Promise<Result<true>> {
  try {
    const supabase = getSupabaseAuthClient();
    const redirectTo = typeof window === 'undefined' ? undefined : `${window.location.origin}/admin`;
    await supabase.auth.resetPasswordForEmail(email.trim().toLowerCase(), { redirectTo });
    return { ok: true, value: true };
  } catch (error) {
    return fail(error instanceof Error ? error.message : 'Falha ao solicitar recuperação.');
  }
}

/** Ação administrativa: sempre acompanhada do JWT do usuário. */
export async function adminInvoke<T>(
  action: string,
  payload: Record<string, unknown> = {},
  accessToken?: string,
): Promise<T> {
  let token = accessToken;
  if (!token) {
    const supabase = getSupabaseAuthClient();
    const { data } = await supabase.auth.getSession();
    token = data.session?.access_token;
  }
  if (!token) throw new Error('not_authenticated');
  return invokeFunction<T>('admin-api', {
    body: { action, payload },
    accessToken: token,
  });
}
