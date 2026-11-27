import { createClient, type Session, type SupabaseClient } from '@supabase/supabase-js';
import { assertBackendConfigured } from './backend/config';
import { invokeFunction } from './backend/http';
import { demoAdminInvoke, isAdminDemoAvailable } from './adminDemoData';

/**
 * Autenticação do painel administrativo.
 *
 * - Login por e-mail/senha (Supabase Auth) — cadastro público desativado.
 * - Segunda etapa obrigatória por TOTP (AAL2). O token de sessão sozinho (AAL1)
 *   não autoriza nenhuma ação administrativa.
 * - Nenhuma chave privilegiada é usada no navegador: apenas a chave pública
 *   `anon`, e a autorização real acontece no banco (`assert_admin`).
 *
 * Garantias desta implementação (missão de endurecimento do MFA):
 *  - Falha na consulta de fatores MFA É tratada como erro real; NUNCA é
 *    interpretada como "ausência de autenticadores" (evita cadastros duplicados
 *    e liberação indevida do painel).
 *  - Falha de rede NUNCA é confundida com ausência de fatores.
 *  - Falha na verificação de permissões NUNCA é confundida com conta fora da
 *    allowlist (campo `adminCheckError` separado de `isAdmin`).
 *  - Cadastros TOTP existentes são identificados antes de iniciar novos.
 *  - Cadastros duplicados são evitados (cache do cadastro em andamento + guarda
 *    de execução concorrente — cobre o React StrictMode).
 *  - O limite de dois autenticadores é respeitado.
 *  - A remoção de um fator exige sessão AAL2 e NUNCA remove o único fator
 *    verificado.
 *  - Após qualquer alteração de fatores, a sessão é reconsultada.
 */

/** Limite de autenticadores TOTP por administrador (模型 AAL2 + reserva). */
export const MAX_TOTP_FACTORS = 2;

let client: SupabaseClient | null = null;

/**
 * Sessão de demonstração do painel (dados fictícios, sem rede).
 *
 * Só pode ser ligada quando `VITE_ADMIN_DEMO=true`. Nesse estado NENHUMA
 * chamada administrativa sai do navegador: tudo é respondido por
 * `adminDemoInvoke`. O caminho real (JWT + allowlist + AAL2) continua intacto
 * e é o único usado fora do modo demonstrativo. Funcionalidades de segurança
 * (gestão de fatores) NÃO estão disponíveis no modo demonstrativo.
 */
let demoSession = false;

export function isAdminDemoSession(): boolean {
  return demoSession && isAdminDemoAvailable();
}

export function setAdminDemoSession(value: boolean): void {
  demoSession = value && isAdminDemoAvailable();
}

export function canUseAdminDemo(): boolean {
  return isAdminDemoAvailable();
}

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
  /** Preenchido quando o usuário precisa concluir o TOTP (não está em AAL2, mas o caminho existe). */
  pendingTotp: boolean;
  /** Fatores TOTP verificados. */
  factors: TotpFactor[];
  /** Fatores TOTP em cadastramento (ainda não verificados). */
  pendingFactors: TotpFactor[];
  isAdmin: boolean;
  mfaSatisfied: boolean;
  /**
   * Erro na verificação de permissões (admin-api). Diferente de `isAdmin=false`:
   * aqui NÃO sabemos se a conta está na allowlist — a checagem falhou. Deve
   * resultar em tela de erro com retry, nunca em "acesso negado" nem em liberação.
   */
  adminCheckError: string | null;
  /**
   * Erro ao listar os fatores MFA. NUNCA significa "não há fatores": a UI deve
   * mostrar erro/retry e NÃO iniciar um novo cadastro cegamente.
   */
  factorError: string | null;
  /** Ainda é possível cadastrar outro autenticador (respeitando o limite). */
  canEnrollMore: boolean;
}

function isNetworkLikeError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error ?? '');
  return /failed to fetch|network|econnrefused|timeout|socket|etimedout|fetch failed/i.test(message);
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
  if (isNetworkLikeError(message)) {
    return 'Falha de comunicação com o serviço de autenticação. Verifique sua conexão e tente novamente.';
  }
  return message;
}

interface FactorBundle {
  verified: TotpFactor[];
  pending: TotpFactor[];
}

/**
 * Lista os fatores TOTP do usuário.
 *
 * IMPORTANTE: qualquer falha (rede, Auth indisponível, erro de API) é retornada
 * como `Fail`. NUNCA retornamos lista vazia em caso de erro — isso evitaria que
 * a UI iniciasse um novo cadastro de forma redundante ou liberasse o painel.
 */
async function getFactors(supabase: SupabaseClient): Promise<Result<FactorBundle>> {
  let data: { totp?: Array<{ id: string; friendly_name: string | null; status: string }> } | null = null;
  let error: { message?: string } | null = null;
  try {
    const response = await supabase.auth.mfa.listFactors();
    data = response.data as FactorBundle extends never ? never : { totp?: Array<{ id: string; friendly_name: string | null; status: string }> } | null;
    error = response.error;
  } catch (thrown) {
    return fail(
      isNetworkLikeError(thrown)
        ? 'Falha de comunicação ao consultar seus autenticadores. Verifique sua conexão e tente novamente.'
        : 'Não foi possível carregar seus autenticadores. Tente novamente.',
    );
  }
  if (error) {
    return fail(
      error.message && isNetworkLikeError(error.message)
        ? 'Falha de comunicação ao consultar seus autenticadores. Verifique sua conexão e tente novamente.'
        : 'Não foi possível carregar seus autenticadores. Tente novamente.',
    );
  }
  const totp = data?.totp ?? [];
  const verified: TotpFactor[] = [];
  const pending: TotpFactor[] = [];
  for (const factor of totp) {
    const mapped: TotpFactor = { id: factor.id, friendlyName: factor.friendly_name ?? null };
    if (factor.status === 'verified') verified.push(mapped);
    else pending.push(mapped);
  }
  return { ok: true, value: { verified, pending } };
}

async function describeSession(supabase: SupabaseClient, session: Session): Promise<AdminSession> {
  // Nível de garantia (AAL). Falha de rede aqui não deve liberar o painel:
  // assumimos o pior caso (aal1) até conseguirmos confirmar.
  let aal: { currentLevel?: string; nextLevel?: string } | null = null;
  try {
    const response = await supabase.auth.mfa.getAuthenticatorAssuranceLevel();
    aal = (response.data as { currentLevel?: string; nextLevel?: string } | null) ?? null;
  } catch {
    aal = null;
  }
  const currentLevel = aal?.currentLevel ?? 'aal1';
  const nextLevel = aal?.nextLevel ?? currentLevel;

  // Fatores MFA — falha de rede NÃO é "ausência de fatores".
  const factorsResult = await getFactors(supabase);
  const factorError = factorsResult.ok ? null : factorsResult.message;
  const verified = factorsResult.ok ? factorsResult.value.verified : [];
  const pending = factorsResult.ok ? factorsResult.value.pending : [];

  // Verificação de permissões — falha NÃO é "fora da allowlist".
  let isAdmin = false;
  let mfaSatisfied = false;
  let adminCheckError: string | null = null;
  try {
    const status = await adminInvoke<{ is_admin: boolean; mfa_satisfied: boolean }>(
      'session',
      {},
      session.access_token,
    );
    isAdmin = status.is_admin === true;
    mfaSatisfied = status.mfa_satisfied === true;
  } catch {
    adminCheckError =
      'Não foi possível verificar suas permissões administrativas. Verifique sua conexão e tente novamente.';
  }

  const total = verified.length + pending.length;

  // Fail-closed (revisão do PR #16): com a listagem OK e NENHUM fator
  // verificado, a sessão NÃO pode ser tratada como AAL2 nem o MFA como
  // satisfeito — mesmo que um token/claim antigo ainda diga `aal2` (ex.:
  // corrida entre dispositivos removeu todos os fatores). O estado remoto
  // manda sobre claims locais.
  const noVerifiedFactors = !factorError && verified.length === 0;
  const effectiveCurrent = noVerifiedFactors && currentLevel === 'aal2' ? 'aal1' : currentLevel;
  const effectivePendingTotp = effectiveCurrent !== 'aal2' && nextLevel === 'aal2';

  return {
    userId: session.user.id,
    email: session.user.email ?? null,
    currentLevel: effectiveCurrent,
    nextLevel,
    pendingTotp: effectivePendingTotp,
    factors: verified,
    pendingFactors: pending,
    isAdmin,
    mfaSatisfied: noVerifiedFactors ? false : mfaSatisfied,
    adminCheckError,
    factorError,
    // Fail-closed: sem certeza da listagem de fatores, não oferecemos cadastro.
    canEnrollMore: !factorError && total < MAX_TOTP_FACTORS,
  };
}

/**
 * Cadastro de TOTP em andamento. Guardamos o segredo/QR para evitar gerar
 * fatores duplicados quando a UI (ex.: React StrictMode) dispara o cadastro
 * mais de uma vez antes da verificação. O segredo é de uso único, por isso só
 * podemos exibi-lo uma vez.
 */
interface PendingEnrollment {
  /** Proprietário do cadastro: NUNCA é reutilizado por outra conta. */
  userId: string;
  factorId: string;
  qrCode: string;
  secret: string;
  createdAt: number;
}
let pendingEnrollment: PendingEnrollment | null = null;
const PENDING_ENROLLMENT_TTL_MS = 10 * 60 * 1000;

/**
 * Cadastros em andamento, isolados POR usuário: uma Promise iniciada por um
 * administrador nunca é reaproveitada por outro (a chave é o `userId` da
 * sessão validada ANTES de qualquer reuso).
 */
const enrollsInFlight = new Map<
  string,
  Promise<Result<PendingEnrollment & { reused: boolean }>>
>();

/** `userId` da sessão atual (null sem sessão ou se a leitura falhar). */
async function currentSessionUserId(supabase: SupabaseClient): Promise<string | null> {
  try {
    const { data } = await supabase.auth.getSession();
    return data.session?.user.id ?? null;
  } catch {
    return null;
  }
}

function clearPendingEnrollment(): void {
  pendingEnrollment = null;
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
    return fail(translateAuthError(error instanceof Error ? error.message : 'Falha ao entrar.'));
  }
}

export async function getCurrentSession(): Promise<Result<AdminSession | null>> {
  if (isAdminDemoSession()) {
    return {
      ok: true,
      value: {
        userId: 'demo-user',
        email: 'painel-demonstracao@prime-store.test',
        currentLevel: 'aal2',
        nextLevel: 'aal2',
        pendingTotp: false,
        factors: [],
        pendingFactors: [],
        isAdmin: true,
        mfaSatisfied: true,
        adminCheckError: null,
        factorError: null,
        canEnrollMore: false,
      },
    };
  }
  try {
    const supabase = getSupabaseAuthClient();
    const { data } = await supabase.auth.getSession();
    if (!data.session) {
      // Sessão encerrada: cadastro em andamento (se houver) não tem mais dono.
      clearPendingEnrollment();
      return { ok: true, value: null };
    }
    return { ok: true, value: await describeSession(supabase, data.session) };
  } catch (error) {
    return fail(translateAuthError(error instanceof Error ? error.message : 'Falha ao ler a sessão.'));
  }
}

/**
 * Inicia (ou reaproveita) o cadastro de um autenticador TOTP.
 *
 * Deduplicação:
 *  - se há um cadastro em andamento recente em memória, reaproveitamos o mesmo
 *    fator (segredo/QR já não podem ser recuperados do Auth);
 *  - se há um fator pendente listado, não criamos outro;
 *  - respeita o limite de `MAX_TOTP_FACTORS`.
 *
 * `reused` indica que nenhum fator novo foi gerado (evita contadores/surtos de UI).
 */
export async function enrollTotpFactor(
  friendlyName = 'Prime Store Admin',
): Promise<Result<PendingEnrollment & { reused: boolean }>> {
  // Gestão de fatores NUNCA roda no modo demonstrativo (defesa em profundidade:
  // a UI também esconde a área de Segurança no modo demo).
  if (isAdminDemoSession()) return fail('Gestão de autenticadores não está disponível no modo demonstrativo.');
  const supabase = getSupabaseAuthClient();

  // 1. Identidade ANTES de reutilizar cache ou Promise: o cadastro pertence a
  //    uma conta específica. Sem sessão, nada é reutilizado.
  const userId = await currentSessionUserId(supabase);
  if (!userId) {
    // Sessão encerrada: o cache não tem mais dono válido.
    clearPendingEnrollment();
    return fail('Sessão expirada. Entre novamente para cadastrar o autenticador.');
  }

  // 2. Cache de OUTRO usuário é descartado, nunca reutilizado nem exposto.
  if (pendingEnrollment && pendingEnrollment.userId !== userId) {
    clearPendingEnrollment();
  }

  // 3. Promise em andamento só é compartilhada ENTRE CHAMADAS DO MESMO usuário.
  const inFlight = enrollsInFlight.get(userId);
  if (inFlight) return inFlight;

  const run = (async (): Promise<Result<PendingEnrollment & { reused: boolean }>> => {
    try {
      // 4. Reaproveita cadastro em andamento do PRÓPRIO usuário (StrictMode /
      //    duplo efeito), dentro do TTL.
      if (
        pendingEnrollment &&
        pendingEnrollment.userId === userId &&
        Date.now() - pendingEnrollment.createdAt < PENDING_ENROLLMENT_TTL_MS
      ) {
        return { ok: true, value: { ...pendingEnrollment, reused: true } };
      }

      // 5. Lista fatores existentes ANTES de criar novo.
      const existing = await getFactors(supabase);
      if (!existing.ok) return fail(existing.message);
      const { verified, pending } = existing.value;

      // 6. Se já existe um fator pendente (de um fluxo anterior), não cria outro.
      //    Não temos o segredo do fator pendente (uso único); orientamos a concluir.
      if (pending.length > 0) {
        return fail(
          'Há um cadastro de autenticador incompleto. Conclua a verificação ou descarte o cadastro antes de iniciar outro.',
        );
      }

      // 7. Respeita o limite de `MAX_TOTP_FACTORS`.
      if (verified.length >= MAX_TOTP_FACTORS) {
        return fail('Você já atingiu o limite de dois autenticadores. Remova um antes de cadastrar outro.');
      }

      // 8. Cria o novo fator.
      const { data, error } = await supabase.auth.mfa.enroll({ factorType: 'totp', friendlyName });
      if (error || !data) return fail(translateAuthError(error?.message ?? 'Falha ao iniciar o TOTP.'));
      if (data.type !== 'totp') return fail('Tipo de fator inesperado.');

      const enrollment: PendingEnrollment = {
        userId,
        factorId: data.id,
        qrCode: data.totp.qr_code,
        secret: data.totp.secret,
        createdAt: Date.now(),
      };

      // 9. Não repovoa o cache se a sessão trocou de dono enquanto esta
      //    operação assíncrona rodava (outro administrador entrou).
      const ownerId = await currentSessionUserId(supabase);
      if (ownerId === userId) pendingEnrollment = enrollment;

      return { ok: true, value: { ...enrollment, reused: false } };
    } catch (error) {
      return fail(translateAuthError(error instanceof Error ? error.message : 'Falha ao iniciar o TOTP.'));
    }
  })();

  enrollsInFlight.set(userId, run);
  try {
    return await run;
  } finally {
    // Remove apenas a entrada deste usuário; outra conta nunca a consulta.
    if (enrollsInFlight.get(userId) === run) enrollsInFlight.delete(userId);
  }
}

/** Compatibilidade: mantém a assinatura usada pelo fluxo legado de primeiro acesso. */
export async function startTotpEnrollment(): Promise<Result<{ factorId: string; qrCode: string; secret: string }>> {
  const result = await enrollTotpFactor('Prime Store Admin');
  if (!result.ok) return { ok: false, message: result.message };
  const { factorId, qrCode, secret } = result.value;
  return { ok: true, value: { factorId, qrCode, secret } };
}

/**
 * Descarta um cadastro de autenticador incompleto (fator PENDENTE).
 *
 * Segurança (revisão do PR #16):
 *  - o estado atual dos fatores é consultado REMOTAMENTE antes de qualquer
 *    remoção — um ID guardado em memória NUNCA é autorização suficiente para
 *    remover um fator;
 *  - se `listFactors()` falhar, a operação é interrompida SEM chamar
 *    `unenroll()`;
 *  - somente fatores cujo estado remoto atual é `pending` (não verificado)
 *    podem ser descartados; se o fator passou a `verified` (ex.: verificado em
 *    outra aba/dispositivo), o descarte é RECUSADO e a lista deve ser
 *    atualizada;
 *  - recebe o `factorId` específico escolhido pelo administrador; sem ID,
 *    só descarta quando existe EXATAMENTE UM fator pendente remoto — nunca
 *    remove vários de uma vez.
 *
 * Revalidação da sessão (equivalente a `removeTotpFactor`): após o
 * `unenroll()` bem-sucedido, a sessão é explicitamente atualizada
 * (`refreshSession`), o AAL e as permissões são revalidados e os fatores são
 * reconsultados. Se a atualização falhar, o descarte NÃO é reportado como
 * concluído (estado aplicado, mas sem confirmação).
 *
 * Retorna a sessão recém-confirmada — ou `null` quando NADA foi descartado
 * (não havia pendente remoto; nenhuma alteração de estado, nenhuma
 * revalidação desnecessária).
 */
export async function discardPendingEnrollment(factorId?: string): Promise<Result<AdminSession | null>> {
  if (isAdminDemoSession()) return fail('Gestão de autenticadores não está disponível no modo demonstrativo.');
  try {
    const supabase = getSupabaseAuthClient();

    // 1. Estado remoto ANTES de qualquer remoção. Falha aqui interrompe
    //    a operação sem tocar nos fatores.
    const listed = await getFactors(supabase);
    if (!listed.ok) return fail(listed.message);
    const { verified, pending } = listed.value;

    // 2. Define o alvo APENAS pelo estado remoto.
    let target: TotpFactor;
    if (factorId) {
      if (verified.some((factor) => factor.id === factorId)) {
        return fail(
          'Este autenticador já está verificado e ativo. Atualize a lista antes de continuar.',
        );
      }
      const remote = pending.find((factor) => factor.id === factorId);
      if (!remote) {
        return fail('Autenticador não encontrado entre os pendentes. Atualize a lista e tente novamente.');
      }
      target = remote;
    } else {
      if (pending.length === 0) {
        // Nada pendente remotamente: qualquer cadastro em memória está
        // obsoleto (foi verificado ou removido em outra sessão) — apenas
        // limpa o cache local, sem remover nada e sem revalidar.
        clearPendingEnrollment();
        return { ok: true, value: null };
      }
      if (pending.length > 1) {
        return fail('Há mais de um cadastro incompleto. Selecione qual deseja descartar.');
      }
      target = pending[0];
    }

    // 3. Remove SOMENTE o alvo confirmado como pendente no estado remoto.
    const { error } = await supabase.auth.mfa.unenroll({ factorId: target.id });
    // Ignora "não encontrado" — já foi removido por outro lado.
    if (error && !/not found|does not exist|no matching/i.test(error.message ?? '')) {
      return fail(translateAuthError(error.message ?? 'Falha ao descartar o cadastro.'));
    }
    if (pendingEnrollment && pendingEnrollment.factorId === target.id) clearPendingEnrollment();

    // 4. Atualiza EXPLICITAMENTE a sessão: o descarte pode ter sido o último
    //    fator da conta (o administrador da área Segurança pode estar em AAL2
    //    e ter outros fatores — ou não). O novo token reflete o estado atual.
    const { data: refreshed, error: refreshError } = await supabase.auth.refreshSession();
    if (refreshError || !refreshed?.session) {
      return fail(
        'O descarte foi aplicado, mas não foi possível confirmar o estado da sessão. Atualize a página e verifique a área Segurança antes de continuar.',
      );
    }

    // 5. Revalida AAL, fatores e permissões contra o estado remoto. A sessão
    //    antiga (ex.: AAL2 de claim anterior) deixa de ser usada: o estado
    //    recém-confirmado é o que retorna — e sem nenhum fator verificado,
    //    `describeSession` já reporta AAL1 (fail-closed).
    const next = await describeSession(supabase, refreshed.session);
    return { ok: true, value: next };
  } catch (error) {
    return fail(translateAuthError(error instanceof Error ? error.message : 'Falha ao descartar o cadastro.'));
  }
}

/** Confirma o código do autenticador e eleva a sessão para AAL2. */
export async function verifyTotp(factorId: string, code: string): Promise<Result<AdminSession>> {
  if (isAdminDemoSession()) return fail('Verificação de autenticador não se aplica ao modo demonstrativo.');
  try {
    const supabase = getSupabaseAuthClient();
    const { error } = await supabase.auth.mfa.challengeAndVerify({
      factorId,
      code: code.replace(/\s+/g, ''),
    });
    if (error) return fail(translateAuthError(error.message));

    // Sucesso: o cadastro em andamento passou a verificado; não reutilizamos mais.
    if (pendingEnrollment && pendingEnrollment.factorId === factorId) clearPendingEnrollment();

    const { data } = await supabase.auth.getSession();
    if (!data.session) return fail('Sessão expirada. Entre novamente.');
    return { ok: true, value: await describeSession(supabase, data.session) };
  } catch (error) {
    return fail(translateAuthError(error instanceof Error ? error.message : 'Falha ao validar o código.'));
  }
}

/**
 * Remove um autenticador TOTP.
 *
 * Regras de segurança:
 *  - exige sessão AAL2 (o próprio dispositivo já verificado deve estar presente);
 *  - NUNCA remove o único fator verificado (evita deixar a conta sem MFA);
 *  - reconsulta a sessão ao final.
 */
export async function removeTotpFactor(factorId: string): Promise<Result<AdminSession>> {
  if (isAdminDemoSession()) return fail('Gestão de autenticadores não está disponível no modo demonstrativo.');
  try {
    const supabase = getSupabaseAuthClient();

    // 1. Exige AAL2 para mexer em fatores.
    let aal: { currentLevel?: string } | null = null;
    try {
      const response = await supabase.auth.mfa.getAuthenticatorAssuranceLevel();
      aal = (response.data as { currentLevel?: string } | null) ?? null;
    } catch {
      aal = null;
    }
    if ((aal?.currentLevel ?? 'aal1') !== 'aal2') {
      return fail('Confirme seu autenticador atual (segunda etapa) antes de remover outro fator.');
    }

    // 2. Reconhece os fatores ANTES de remover.
    const factorsResult = await getFactors(supabase);
    if (!factorsResult.ok) return fail(factorsResult.message);
    const { verified, pending } = factorsResult.value;
    const target = [...verified, ...pending].find((factor) => factor.id === factorId);
    if (!target) return fail('Autenticador não encontrado.');

    // 3. Nunca remove o único fator verificado.
    const isLastVerified = verified.length === 1 && verified[0].id === factorId;
    if (isLastVerified) {
      return fail('Não é possível remover o único autenticador verificado. Mantenha ao menos um fator ativo.');
    }

    // 4. Remove.
    const { error } = await supabase.auth.mfa.unenroll({ factorId });
    if (error) return fail(translateAuthError(error.message ?? 'Falha ao remover o autenticador.'));
    if (pendingEnrollment && pendingEnrollment.factorId === factorId) clearPendingEnrollment();

    // 5. Atualiza EXPLICITAMENTE a sessão: o novo token reflete o estado atual
    //    dos fatores. Necessário porque a remoção pode mudar o AAL efetivo
    //    (ex.: corrida entre dispositivos removeu o último fator — a sessão
    //    não pode continuar sendo tratada como AAL2 com base em claim antigo).
    const { data: refreshed, error: refreshError } = await supabase.auth.refreshSession();
    if (refreshError || !refreshed?.session) {
      return fail(
        'A remoção foi aplicada, mas não foi possível confirmar o estado da sessão. Atualize a página e verifique a aba Segurança antes de continuar.',
      );
    }

    // 6. Revalida o AAL e reconsulta os fatores contra o estado remoto
    //    (describeSession refaz getAuthenticatorAssuranceLevel + listFactors
    //    + verificação de permissões no admin-api). A operação só é tratada
    //    como concluída com o estado recém-confirmado — e a sessão sem
    //    nenhum fator verificado volta a ser reportada como AAL1
    //    (fail-closed em describeSession), nunca como AAL2.
    const next = await describeSession(supabase, refreshed.session);
    return { ok: true, value: next };
  } catch (error) {
    return fail(translateAuthError(error instanceof Error ? error.message : 'Falha ao remover o autenticador.'));
  }
}

export async function signOutAdmin(): Promise<void> {
  if (isAdminDemoSession()) {
    clearPendingEnrollment();
    enrollsInFlight.clear();
    demoSession = false;
    return;
  }
  clearPendingEnrollment();
  enrollsInFlight.clear();
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
    return fail(translateAuthError(error instanceof Error ? error.message : 'Falha ao solicitar recuperação.'));
  }
}

/** Ação administrativa: sempre acompanhada do JWT do usuário. */
export async function adminInvoke<T>(
  action: string,
  payload: Record<string, unknown> = {},
  accessToken?: string,
): Promise<T> {
  // Modo demonstração: nenhuma requisição é feita; a resposta é fictícia.
  if (isAdminDemoSession()) return demoAdminInvoke<T>(action, payload);

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
