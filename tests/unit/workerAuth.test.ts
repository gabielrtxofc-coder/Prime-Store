import { describe, expect, it } from 'vitest';
import { isServiceRole, makeRoleJwt } from '../../supabase/functions/_shared/handlers/wyviWorker';

/**
 * Autenticação do worker (Fase 01): duas camadas —
 * `verify_jwt=true` (plataforma, fora do código) + papel `service_role`
 * validado aqui. Este arquivo cobre a camada do handler: qualquer entrada
 * sem o claim exato é recusada ANTES de tocar na fila.
 */
function requestWithAuth(headerValue: string | null): Request {
  const headers: Record<string, string> = {};
  if (headerValue !== null) headers.Authorization = headerValue;
  return new Request('https://eorlmqolbknrplvdbbtl.supabase.co/functions/v1/wyvi-worker', {
    method: 'POST',
    headers,
    body: '{}',
  });
}

describe('worker — isServiceRole (camada do handler)', () => {
  it('aceita APENAS o claim role=service_role', () => {
    expect(isServiceRole(requestWithAuth(`Bearer ${makeRoleJwt('service_role')}`))).toBe(true);
  });

  it('rejeita JWT de anon (verifcado pela plataforma, recusado aqui)', () => {
    expect(isServiceRole(requestWithAuth(`Bearer ${makeRoleJwt('anon')}`))).toBe(false);
  });

  it('rejeita authenticated e papéis arbitrários', () => {
    expect(isServiceRole(requestWithAuth(`Bearer ${makeRoleJwt('authenticated')}`))).toBe(false);
    expect(isServiceRole(requestWithAuth(`Bearer ${makeRoleJwt('')}`))).toBe(false);
  });

  it('rejeita ausência de cabeçalho, Bearer vazio e token sem claim', () => {
    expect(isServiceRole(requestWithAuth(null))).toBe(false);
    expect(isServiceRole(requestWithAuth('Bearer '))).toBe(false);
    expect(isServiceRole(requestWithAuth('Bearer abc.def'))).toBe(false);
    expect(isServiceRole(requestWithAuth('Bearer abc'))).toBe(false);
  });

  it('rejeita JWT malformado (base64 inválido no payload)', () => {
    expect(isServiceRole(requestWithAuth('Bearer header.!!!invalido!!!.assinatura'))).toBe(false);
  });

  it('rejeita payload JSON que não é objeto com role', () => {
    const enc = (value: string) => btoa(value).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    const jwt = `${enc('{"alg":"HS256"}')}.${enc('"nao-objeto"')}.x`;
    expect(isServiceRole(requestWithAuth(`Bearer ${jwt}`))).toBe(false);
    const jwtRoleErrado = `${enc('{"alg":"HS256"}')}.${enc('{"role":"service_rolex"}')}.x`;
    expect(isServiceRole(requestWithAuth(`Bearer ${jwtRoleErrado}`))).toBe(false);
  });
});
