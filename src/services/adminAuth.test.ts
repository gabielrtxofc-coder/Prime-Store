import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Endurecimento do MFA administrativo — testes do serviço de autenticação.
 *
 * Cobertura exigida pela missão (falha de comunicação com o Supabase Auth,
 * falha na consulta de fatores, múltiplos fatores TOTP, fatores pendentes,
 * repetição de efeito no React StrictMode, cadastro/verificação de fator
 * reserva, remoção do segundo fator, tentativa de remoção do último fator e
 * sessões AAL1/AAL2).
 *
 * O cliente Supabase e a camada HTTP são simulados no limite do módulo e são
 * COM ESTADO (como um servidor de Auth de verdade): challenge bem-sucedido
 * promove o fator para `verified`; unenroll remove da lista. Cada teste
 * recarrega o módulo (`vi.resetModules`) para isolar o estado interno do
 * serviço (cache de cadastro em andamento).
 */

const h = vi.hoisted(() => {
  return {
    session: null as null | { access_token: string; user: { id: string; email: string | null } },
    aal: { currentLevel: 'aal1', nextLevel: 'aal1' },
    totp: [] as Array<{ id: string; friendly_name: string | null; status: string }>,
    signInError: null as { message: string } | null,
    listFactorsError: null as { message: string } | null,
    listFactorsThrow: null as unknown,
    getAalThrow: null as unknown,
    getSessionThrow: null as unknown,
    enrollError: null as { message: string } | null,
    enrollCalls: [] as Array<{ factorType: string; friendlyName?: string }>,
    challengeError: null as { message: string } | null,
    challengeCalls: [] as Array<{ factorId: string; code: string }>,
    unenrollCalls: [] as string[],
    unenrollError: null as { message: string } | null,
    adminStatus: { is_admin: true, mfa_satisfied: true } as { is_admin: boolean; mfa_satisfied: boolean },
    adminThrow: null as unknown,
  };
});

vi.mock('@supabase/supabase-js', () => ({
  createClient: () => ({
    auth: {
      signInWithPassword: async () =>
        h.signInError
          ? { data: { session: null }, error: h.signInError }
          : { data: { session: h.session }, error: null },
      getSession: async () => {
        if (h.getSessionThrow) throw h.getSessionThrow;
        return { data: { session: h.session } };
      },
      signOut: async () => ({}),
      resetPasswordForEmail: async () => ({ data: {}, error: null }),
      mfa: {
        getAuthenticatorAssuranceLevel: async () => {
          if (h.getAalThrow) throw h.getAalThrow;
          return { data: { currentLevel: h.aal.currentLevel, nextLevel: h.aal.nextLevel } };
        },
        listFactors: async () => {
          if (h.listFactorsThrow) throw h.listFactorsThrow;
          if (h.listFactorsError) return { data: null, error: h.listFactorsError };
          return { data: { totp: h.totp.map((factor) => ({ ...factor })) }, error: null };
        },
        enroll: async (params: { factorType: string; friendlyName?: string }) => {
          h.enrollCalls.push(params);
          if (h.enrollError) return { data: null, error: h.enrollError };
          return {
            data: {
              id: `fator-novo-${h.enrollCalls.length}`,
              type: 'totp',
              totp: { qr_code: 'data:image/svg+xml;base64,UVI9', secret: `SEGREDO-${h.enrollCalls.length}` },
            },
            error: null,
          };
        },
        challengeAndVerify: async (params: { factorId: string; code: string }) => {
          h.challengeCalls.push(params);
          if (h.challengeError) return { error: h.challengeError };
          // Estado-stateful: fator verificado após challenge bem-sucedido.
          const factor = h.totp.find((item) => item.id === params.factorId);
          if (factor) factor.status = 'verified';
          return { error: null };
        },
        unenroll: async (params: { factorId: string }) => {
          h.unenrollCalls.push(params.factorId);
          if (h.unenrollError) return { error: h.unenrollError };
          h.totp = h.totp.filter((factor) => factor.id !== params.factorId);
          return { error: null };
        },
      },
    },
  }),
}));

vi.mock('./backend/config', () => ({
  assertBackendConfigured: () => ({ supabaseUrl: 'https://fake.supabase.test', anonKey: 'chave-anon' }),
}));

vi.mock('./backend/http', () => ({
  invokeFunction: async <T,>(_name: string, _init: unknown): Promise<T> => {
    if (h.adminThrow) throw h.adminThrow;
    return h.adminStatus as T;
  },
}));

async function loadAuth(): Promise<typeof import('./adminAuth')> {
  vi.resetModules();
  return await import('./adminAuth');
}

function resetState() {
  h.session = { access_token: 'jwt-admin', user: { id: 'user-1', email: 'dono@prime-store.test' } };
  h.aal = { currentLevel: 'aal1', nextLevel: 'aal1' };
  h.totp = [];
  h.signInError = null;
  h.listFactorsError = null;
  h.listFactorsThrow = null;
  h.getAalThrow = null;
  h.getSessionThrow = null;
  h.enrollError = null;
  h.enrollCalls = [];
  h.challengeError = null;
  h.challengeCalls = [];
  h.unenrollCalls = [];
  h.unenrollError = null;
  h.adminStatus = { is_admin: true, mfa_satisfied: true };
  h.adminThrow = null;
}

beforeEach(resetState);

describe('adminAuth — endurecimento do MFA', () => {
  it('falha de comunicação com o Supabase Auth no login vira erro claro (nunca "sem autenticadores")', async () => {
    const auth = await loadAuth();
    h.signInError = { message: 'Failed to fetch' };

    const result = await auth.signInWithPassword('dono@prime-store.test', 'senha');

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).toMatch(/comunicação/i);
  });

  it('falha na consulta de fatores define factorError e nunca vira lista vazia "confiável"', async () => {
    const auth = await loadAuth();
    h.aal = { currentLevel: 'aal1', nextLevel: 'aal2' };
    h.adminStatus = { is_admin: true, mfa_satisfied: false };
    h.listFactorsError = { message: 'boom' };

    const result = await auth.signInWithPassword('dono@prime-store.test', 'senha');

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.factorError).toBeTruthy();
      expect(result.value.isAdmin).toBe(true);
      // Fail-closed: sem listagem confiável, não se oferece cadastro novo.
      expect(result.value.canEnrollMore).toBe(false);
    }
  });

  it('listFactors lançando erro de rede (ex.: Auth fora do ar) define factorError com orientação', async () => {
    const auth = await loadAuth();
    h.adminStatus = { is_admin: true, mfa_satisfied: false };
    h.listFactorsThrow = new Error('Failed to fetch');

    const result = await auth.signInWithPassword('dono@prime-store.test', 'senha');

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.factorError).toMatch(/comunicação/i);
  });

  it('falha na verificação de permissões NÃO é confundida com conta fora da allowlist', async () => {
    const auth = await loadAuth();
    h.adminThrow = new Error('Failed to fetch');

    const result = await auth.signInWithPassword('dono@prime-store.test', 'senha');

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.isAdmin).toBe(false);
      expect(result.value.adminCheckError).toMatch(/permissões/i);
    }
  });

  it('fora da allowlist de verdade: isAdmin=false SEM adminCheckError', async () => {
    const auth = await loadAuth();
    h.adminStatus = { is_admin: false, mfa_satisfied: false };

    const result = await auth.signInWithPassword('dono@prime-store.test', 'senha');

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.isAdmin).toBe(false);
      expect(result.value.adminCheckError).toBeNull();
    }
  });

  it('múltiplos fatores TOTP verificados são listados e bloqueiam novo cadastro', async () => {
    const auth = await loadAuth();
    h.aal = { currentLevel: 'aal2', nextLevel: 'aal2' };
    h.totp = [
      { id: 'f-principal', friendly_name: 'Celular pessoal', status: 'verified' },
      { id: 'f-reserva', friendly_name: 'Celular reserva', status: 'verified' },
    ];

    const result = await auth.getCurrentSession();

    expect(result.ok).toBe(true);
    if (result.ok && result.value) {
      expect(result.value.factors).toHaveLength(2);
      expect(result.value.pendingFactors).toHaveLength(0);
      expect(result.value.mfaSatisfied).toBe(true);
      expect(result.value.canEnrollMore).toBe(false);
    }

    const enroll = await auth.enrollTotpFactor('Reserva');
    expect(enroll.ok).toBe(false);
    if (!enroll.ok) expect(enroll.message).toMatch(/limite de dois/i);
    expect(h.enrollCalls).toHaveLength(0);
  });

  it('fatores pendentes são listados separadamente e impedem cadastro duplicado', async () => {
    const auth = await loadAuth();
    h.aal = { currentLevel: 'aal1', nextLevel: 'aal2' };
    h.adminStatus = { is_admin: true, mfa_satisfied: false };
    h.totp = [
      { id: 'f-principal', friendly_name: 'Celular pessoal', status: 'verified' },
      { id: 'f-incompleto', friendly_name: 'Prime Store Admin', status: 'pending' },
    ];

    const result = await auth.getCurrentSession();

    expect(result.ok).toBe(true);
    if (result.ok && result.value) {
      expect(result.value.factors.map((factor) => factor.id)).toEqual(['f-principal']);
      expect(result.value.pendingFactors.map((factor) => factor.id)).toEqual(['f-incompleto']);
      expect(result.value.canEnrollMore).toBe(false);
    }

    const enroll = await auth.enrollTotpFactor('Outro');
    expect(enroll.ok).toBe(false);
    if (!enroll.ok) expect(enroll.message).toMatch(/incompleto/i);
    expect(h.enrollCalls).toHaveLength(0);
  });

  it('repetição do efeito (React StrictMode) NÃO cadastra dois fatores', async () => {
    const auth = await loadAuth();
    h.adminStatus = { is_admin: true, mfa_satisfied: false };

    const first = await auth.enrollTotpFactor('Prime Store Admin');
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    expect(first.value.reused).toBe(false);

    const second = await auth.enrollTotpFactor('Prime Store Admin');
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(second.value.reused).toBe(true);
    expect(second.value.factorId).toBe(first.value.factorId);
    expect(second.value.secret).toBe(first.value.secret);
    expect(h.enrollCalls).toHaveLength(1);
  });

  it('cadastro concorrente (dois efeitos em paralelo) cria um único fator', async () => {
    const auth = await loadAuth();
    h.adminStatus = { is_admin: true, mfa_satisfied: false };

    const [a, b] = await Promise.all([auth.enrollTotpFactor('Prime Store Admin'), auth.enrollTotpFactor('Prime Store Admin')]);

    expect(a.ok).toBe(true);
    expect(b.ok).toBe(true);
    if (a.ok && b.ok) expect(b.value.factorId).toBe(a.value.factorId);
    expect(h.enrollCalls).toHaveLength(1);
  });

  it('cadastro e verificação de fator reserva: AAL2 e dois fatores verificados', async () => {
    const auth = await loadAuth();
    h.aal = { currentLevel: 'aal2', nextLevel: 'aal2' };
    h.totp = [{ id: 'f-principal', friendly_name: 'Celular pessoal', status: 'verified' }];

    const enroll = await auth.enrollTotpFactor('Reserva');
    expect(enroll.ok).toBe(true);
    if (!enroll.ok) return;
    expect(enroll.value.reused).toBe(false);
    const reservaId = enroll.value.factorId;

    // O fator reserva entra como pendente na listagem (aguardando verificação).
    h.totp.push({ id: reservaId, friendly_name: 'Reserva', status: 'pending' });

    const verified = await auth.verifyTotp(reservaId, '123456');
    expect(verified.ok).toBe(true);
    if (!verified.ok) return;
    expect(h.challengeCalls).toEqual([{ factorId: reservaId, code: '123456' }]);
    expect(verified.value.currentLevel).toBe('aal2');
    expect(verified.value.factors).toHaveLength(2);
    expect(verified.value.pendingFactors).toHaveLength(0);
    expect(verified.value.mfaSatisfied).toBe(true);

    // Cache de cadastro limpo após verificação: novo cadastro respeita o limite.
    const again = await auth.enrollTotpFactor('Terceiro');
    expect(again.ok).toBe(false);
    if (!again.ok) expect(again.message).toMatch(/limite de dois/i);
  });

  it('código inválido é recusado com mensagem clara e o painel não é liberado', async () => {
    const auth = await loadAuth();
    h.aal = { currentLevel: 'aal1', nextLevel: 'aal2' };
    h.adminStatus = { is_admin: true, mfa_satisfied: false };
    h.totp = [{ id: 'f-principal', friendly_name: 'Celular pessoal', status: 'verified' }];
    h.challengeError = { message: 'Invalid TOTP code detected' };

    const result = await auth.verifyTotp('f-principal', '000000');

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).toMatch(/Código de verificação inválido/i);
    expect(h.challengeCalls).toHaveLength(1);
  });

  it('remoção do segundo fator (verificado) funciona em sessão AAL2', async () => {
    const auth = await loadAuth();
    h.aal = { currentLevel: 'aal2', nextLevel: 'aal2' };
    h.totp = [
      { id: 'f-principal', friendly_name: 'Celular pessoal', status: 'verified' },
      { id: 'f-reserva', friendly_name: 'Celular reserva', status: 'verified' },
    ];

    const result = await auth.removeTotpFactor('f-reserva');

    expect(result.ok).toBe(true);
    expect(h.unenrollCalls).toEqual(['f-reserva']);
    if (result.ok) expect(result.value.factors.map((factor) => factor.id)).toEqual(['f-principal']);
  });

  it('tentativa de remoção do ÚLTIMO fator verificado é bloqueada', async () => {
    const auth = await loadAuth();
    h.aal = { currentLevel: 'aal2', nextLevel: 'aal2' };
    h.totp = [{ id: 'f-principal', friendly_name: 'Celular pessoal', status: 'verified' }];

    const result = await auth.removeTotpFactor('f-principal');

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).toMatch(/único autenticador/i);
    expect(h.unenrollCalls).toHaveLength(0);
  });

  it('remoção de fator exige sessão AAL2', async () => {
    const auth = await loadAuth();
    h.aal = { currentLevel: 'aal1', nextLevel: 'aal2' };
    h.totp = [
      { id: 'f-principal', friendly_name: 'Celular pessoal', status: 'verified' },
      { id: 'f-reserva', friendly_name: 'Celular reserva', status: 'verified' },
    ];

    const result = await auth.removeTotpFactor('f-reserva');

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).toMatch(/segunda etapa|AAL2/i);
    expect(h.unenrollCalls).toHaveLength(0);
  });

  it('fator PENDENTE pode ser removido mesmo sendo o único listado (não enfraquece MFA)', async () => {
    const auth = await loadAuth();
    h.aal = { currentLevel: 'aal2', nextLevel: 'aal2' };
    h.totp = [{ id: 'f-incompleto', friendly_name: 'Prime Store Admin', status: 'pending' }];

    const result = await auth.removeTotpFactor('f-incompleto');

    expect(result.ok).toBe(true);
    expect(h.unenrollCalls).toEqual(['f-incompleto']);
  });

  it('descarte de cadastro incompleto remove o fator pendente e libera novo cadastro', async () => {
    const auth = await loadAuth();
    h.adminStatus = { is_admin: true, mfa_satisfied: false };

    const enroll = await auth.enrollTotpFactor('Prime Store Admin');
    expect(enroll.ok).toBe(true);

    const discard = await auth.discardPendingEnrollment();
    expect(discard.ok).toBe(true);
    expect(h.unenrollCalls).toEqual(['fator-novo-1']);

    // Cache limpo: um novo cadastro cria um fator novo (não reutiliza o descartado).
    const again = await auth.enrollTotpFactor('Prime Store Admin');
    expect(again.ok).toBe(true);
    if (again.ok) {
      expect(again.value.reused).toBe(false);
      expect(again.value.factorId).toBe('fator-novo-2');
    }
    expect(h.enrollCalls).toHaveLength(2);
  });

  it('sessão AAL1 pede segunda etapa; sessão AAL2 satisfaz o MFA', async () => {
    const auth = await loadAuth();

    h.aal = { currentLevel: 'aal1', nextLevel: 'aal2' };
    h.adminStatus = { is_admin: true, mfa_satisfied: false };
    const aal1 = await auth.getCurrentSession();
    expect(aal1.ok).toBe(true);
    if (aal1.ok && aal1.value) {
      expect(aal1.value.currentLevel).toBe('aal1');
      expect(aal1.value.pendingTotp).toBe(true);
      expect(aal1.value.mfaSatisfied).toBe(false);
    }

    h.aal = { currentLevel: 'aal2', nextLevel: 'aal2' };
    h.adminStatus = { is_admin: true, mfa_satisfied: true };
    const aal2 = await auth.getCurrentSession();
    expect(aal2.ok).toBe(true);
    if (aal2.ok && aal2.value) {
      expect(aal2.value.currentLevel).toBe('aal2');
      expect(aal2.value.pendingTotp).toBe(false);
      expect(aal2.value.mfaSatisfied).toBe(true);
    }
  });

  it('nível AAL indisponível é tratado como AAL1 (fail-closed)', async () => {
    const auth = await loadAuth();
    h.getAalThrow = new Error('Failed to fetch');
    h.adminStatus = { is_admin: true, mfa_satisfied: false };

    const result = await auth.getCurrentSession();

    expect(result.ok).toBe(true);
    if (result.ok && result.value) expect(result.value.currentLevel).toBe('aal1');
  });

  it('sem sessão, getCurrentSession retorna null sem erro', async () => {
    const auth = await loadAuth();
    h.session = null;

    const result = await auth.getCurrentSession();

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value).toBeNull();
  });
});
