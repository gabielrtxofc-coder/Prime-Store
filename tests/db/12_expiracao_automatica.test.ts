import { beforeAll, describe, expect, it } from 'vitest';
import type { Client } from 'pg';
import { connect, createOrder, resetDatabase, runSql, seedProduct, sqlValue } from './helpers';

/**
 * Missão 07 — etapa 02: execução automática da expiração de reservas.
 *
 * O agendador (`pg_cron`) não existe no PostgreSQL local usado pelo harness, e
 * a migração 0031 é deliberadamente no-op nesse caso. O que este arquivo prova é
 * o que depende do banco e pode ser verificado em qualquer ambiente:
 *
 *   - a função executada pelo agendador encerra reservas vencidas e devolve o
 *     estoque, reaproveitando `expire_overdue_reservations` (sem duplicar regra);
 *   - reserva válida não é afetada;
 *   - execuções repetidas e simultâneas não devolvem a mesma unidade duas vezes;
 *   - falhas ficam registradas e identificáveis em `job_health`;
 *   - `job_health` não é acessível a `anon`/`authenticated`.
 *
 * Quando o banco tiver `pg_cron`, a última seção confere o agendamento criado.
 */

interface RunResult {
  result: string;
  released_units?: number;
  source?: string;
  error_code?: string;
}

async function runExpiry(source = 'test'): Promise<RunResult> {
  const rows = await runSql<{ result: RunResult }>(
    `select public.run_reservation_expiry($1) as result`,
    [source],
  );
  return rows[0].result;
}

async function expireReservationByClock(orderId: string): Promise<void> {
  await runSql(
    `update public.stock_reservations
        set starts_at = now() - interval '35 minutes',
            expires_at = now() - interval '5 minutes'
      where order_id = $1`,
    [orderId],
  );
  await runSql(`update public.orders set reservation_expires_at = now() - interval '5 minutes' where id = $1`, [
    orderId,
  ]);
}

const unitsByStatus = (productId: string) =>
  runSql<{ status: string; total: string }>(
    `select status, count(*)::text as total from public.stock_units where product_id = $1 group by status`,
    [productId],
  );

describe('execução automática da expiração de reservas', () => {
  let client: Client;

  beforeAll(async () => {
    await resetDatabase();
    client = await connect();
  }, 60000);

  it('não expira reserva que ainda está dentro da janela', async () => {
    const seed = await seedProduct({ stockUnits: 2, maxQuantity: 2 });
    const { order } = await createOrder(seed.productId, 1);

    const run = await runExpiry();
    expect(run.result).toBe('ok');
    expect(run.released_units).toBe(0);

    const state = await sqlValue<string>(`select status from public.orders where id = $1`, [order.id ?? order.order_id]);
    expect(state).toBe('pending_payment');
    const statuses = await unitsByStatus(seed.productId);
    expect(statuses.find((row) => row.status === 'reserved')?.total).toBe('1');
  });

  it('encerra a reserva vencida e devolve a unidade ao estoque', async () => {
    const seed = await seedProduct({ stockUnits: 1 });
    const { order } = await createOrder(seed.productId, 1);
    await expireReservationByClock(order.order_id);

    const run = await runExpiry();
    expect(run.result).toBe('ok');
    expect(run.released_units).toBe(1);

    expect(await sqlValue<string>(`select status from public.orders where id = $1`, [order.order_id])).toBe('expired');
    expect(await sqlValue<string>(`select status from public.stock_reservations where order_id = $1`, [order.order_id])).toBe('expired');
    expect(await sqlValue<string>(`select status from public.stock_units where id = $1`, [seed.units[0]])).toBe('available');

    // O histórico do pedido registra a expiração feita pelo sistema.
    expect(
      Number(
        await sqlValue<number>(
          `select count(*) from public.order_events where order_id = $1 and event_type = 'reservation_expired'`,
          [order.order_id],
        ),
      ),
    ).toBe(1);
  });

  it('execução repetida não devolve a mesma unidade duas vezes', async () => {
    const seed = await seedProduct({ stockUnits: 1 });
    const { order } = await createOrder(seed.productId, 1);
    await expireReservationByClock(order.order_id);

    const first = await runExpiry();
    expect(first.released_units).toBe(1);

    const second = await runExpiry();
    expect(second.result).toBe('ok');
    expect(second.released_units).toBe(0);

    const units = await runSql<{ id: string; status: string; total: number }>(
      `select id, status, count(*) over () as total from public.stock_units where product_id = $1`,
      [seed.productId],
    );
    // Uma unidade física, disponível uma única vez — nenhuma linha duplicada.
    expect(units).toHaveLength(1);
    expect(units[0].status).toBe('available');
    expect(Number(units[0].total)).toBe(1);
  });

  it('duas execuções simultâneas não disputam a mesma reserva', async () => {
    const seed = await seedProduct({ stockUnits: 2, maxQuantity: 2 });
    const { order } = await createOrder(seed.productId, 2);
    await expireReservationByClock(order.order_id);

    const [first, second] = await Promise.all([runExpiry('simultaneo-a'), runExpiry('simultaneo-b')]);
    const released = [first, second]
      .filter((run) => run.result === 'ok')
      .reduce((sum, run) => sum + Number(run.released_units ?? 0), 0);

    // As duas unidades são devolvidas uma única vez no total, mesmo que uma das
    // execuções tenha sido ignorada pelo advisory lock.
    expect(released).toBe(2);
    const statuses = await unitsByStatus(seed.productId);
    expect(statuses).toEqual([{ status: 'available', total: '2' }]);
    expect(await sqlValue<string>(`select status from public.orders where id = $1`, [order.order_id])).toBe('expired');
  });

  it('falha na execução fica registrada com código, sem vazar mensagem', async () => {
    const original = await sqlValue<string>(
      `select pg_get_functiondef('public.expire_overdue_reservations(uuid)'::regprocedure)`,
    );

    // Provoca uma falha real na função de expiração (permissão do dono revogada
    // por uma versão temporária que só levanta erro) e confere o registro.
    await runSql(`
      create or replace function public.expire_overdue_reservations(p_product_id uuid default null)
      returns integer language plpgsql security definer set search_path = public, pg_temp
      as $$ begin raise exception 'falha simulada do agendador'; end; $$
    `);

    try {
      const run = await runExpiry('teste-de-falha');
      expect(run.result).toBe('failed');
      expect(run.error_code).toBe('P0001');

      const health = await runSql<{
        job_name: string;
        consecutive_failures: number;
        last_error_code: string;
      }>(
        `select job_name, consecutive_failures, last_error_code
           from public.job_health where job_name = 'expire_overdue_reservations'`,
      );
      expect(health[0].consecutive_failures).toBeGreaterThanOrEqual(1);
      expect(health[0].last_error_code).toBe('P0001');
    } finally {
      await runSql(original);
    }

    // Depois da restauração, o próximo ciclo zera as falhas.
    const recovered = await runExpiry('recuperacao');
    expect(recovered.result).toBe('ok');
    const health = await runSql<{ consecutive_failures: number; last_error_code: string | null; last_success_at: string }>(
      `select consecutive_failures, last_error_code, last_success_at
         from public.job_health where job_name = 'expire_overdue_reservations'`,
    );
    expect(health[0].consecutive_failures).toBe(0);
    expect(health[0].last_error_code).toBeNull();
    expect(health[0].last_success_at).not.toBeNull();
  }, 30000);

  it('job_health é interna: anon e authenticated não leem nem escrevem', async () => {
    const { runAs } = await import('./helpers');
    await expect(
      runAs(`select * from public.job_health`, [], { role: 'anon' }),
    ).rejects.toMatchObject({ code: '42501' });
    await expect(
      runAs(`select * from public.job_health`, [], { role: 'authenticated', claims: { role: 'authenticated' } }),
    ).rejects.toMatchObject({ code: '42501' });
    await expect(
      runAs(`select public.run_reservation_expiry('anon')`, [], { role: 'anon' }),
    ).rejects.toMatchObject({ code: '42501' });
  });

  it('o agendamento existe quando o banco oferece pg_cron', async () => {
    const hasCron = await sqlValue<number>(
      `select count(*) from pg_namespace where nspname = 'cron'`,
    );

    if (Number(hasCron) === 0) {
      // Ambiente local do harness: a migração é no-op por desenho.
      expect(Number(hasCron)).toBe(0);
      return;
    }

    const job = await runSql<{ jobname: string; schedule: string; command: string; active: boolean }>(
      `select jobname, schedule, command, active from cron.job where jobname = 'prime-store-expire-reservations'`,
    );
    expect(job).toHaveLength(1);
    expect(job[0].schedule).toBe('* * * * *');
    expect(job[0].command).toContain('run_reservation_expiry');
    expect(job[0].active).toBe(true);
  });
});
