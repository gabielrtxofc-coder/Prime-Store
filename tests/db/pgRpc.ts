import type { Client } from 'pg';
import type { RpcFn } from '../../supabase/functions/_shared/rest';

export interface RpcSession {
  role?: 'anon' | 'authenticated' | 'service_role';
  claims?: Record<string, unknown>;
}

/**
 * Adaptador que executa as mesmas RPCs chamadas pela Edge Function diretamente
 * no PostgreSQL, usando argumentos nomeados. Valida o contrato real das funções
 * (nomes de parâmetros, tipos e comportamento transacional).
 *
 * Com `session`, reproduz exatamente o que o PostgREST faz: aplica o papel e as
 * claims do JWT antes de executar a função.
 */
export function createPgRpc(client: Client, session: RpcSession = {}): RpcFn {
  return async function rpc<T = unknown>(
    name: string,
    args: Record<string, unknown> = {},
  ): Promise<T> {
    const keys = Object.keys(args);
    const named = keys.length === 0 ? '' : keys.map((key, index) => `${key} => $${index + 1}`).join(', ');
    const values = keys.map((key) => args[key]);
    const sql = `select public.${name}(${named}) as result`;

    if (!session.role && !session.claims) {
      const { rows } = await client.query(sql, values);
      return (rows[0]?.result ?? null) as T;
    }

    await client.query('begin');
    try {
      if (session.role) await client.query(`set local role ${session.role}`);
      if (session.claims) {
        await client.query('select set_config($1, $2, true)', [
          'request.jwt.claims',
          JSON.stringify(session.claims),
        ]);
      }
      const { rows } = await client.query(sql, values);
      await client.query('commit');
      return (rows[0]?.result ?? null) as T;
    } catch (error) {
      await client.query('rollback');
      throw error;
    }
  };
}
