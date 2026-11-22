import {readFileSync} from 'node:fs';
import {expect, it} from 'vitest';
import {connect, MIGRATIONS_DIR} from './helpers';

it('agenda para o projeto do token sem gravar o bearer no cron', async () => {
  const db = await connect();
  try {
    await db.query('begin');
    // Substitutos transacionais: nenhuma extensão envia tráfego no teste.
    await db.query(`create schema cron; create schema net; create schema if not exists vault;
      create table cron.job(jobname text primary key, schedule text, command text, active boolean not null default true, username text not null default 'postgres');
      create table net.http_request_queue(url text);
      create table vault.decrypted_secrets(name text, decrypted_secret text);
      create function cron.schedule(text,text,text) returns void language sql as $$insert into cron.job(jobname,schedule,command) values ($1,$2,$3) on conflict(jobname) do update set schedule=excluded.schedule, command=excluded.command, active=true$$;
      create function net.http_post(url text,headers jsonb,body jsonb) returns void language sql as $$insert into net.http_request_queue values ($1)$$;`);
    const ref = 'abcdefghijklmnopqrst';
    const jwt = 'fixture.' + Buffer.from(JSON.stringify({ref,role:'service_role'})).toString('base64url') + '.fixture';
    await db.query("insert into vault.decrypted_secrets values ('wyvi_worker_jwt',$1)",[jwt]);
    const install = readFileSync(`${MIGRATIONS_DIR}/20261120160000_0045_worker_destino_por_projeto.sql`,'utf8');
    await db.query(install);
    await db.query(install);
    expect((await db.query('select count(*)::int as n from cron.job')).rows[0].n).toBe(1);
    const {rows:[job]} = await db.query('select jobname, schedule, active, username, command from cron.job');
    expect(job.jobname).toBe('prime-store-wyvi-worker');
    expect(job.schedule).toBe('* * * * *');
    expect(job.active).toBe(true);
    expect(job.username).toBe('postgres');
    expect(job.command).not.toContain(jwt);
    expect(job.command).toContain('decrypted_secret');
    expect(job.command).toContain("c->>'ref'");
    expect(job.command).toContain("c->>'role' = 'service_role'");
    expect(job.command).toContain(".supabase.co/functions/v1/wyvi-worker");
    await db.query(job.command);
    expect((await db.query('select url from net.http_request_queue')).rows).toEqual([{url:`https://${ref}.supabase.co/functions/v1/wyvi-worker`}]);
  } finally {await db.query('rollback'); await db.end();}
});
