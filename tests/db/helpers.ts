import { createHash, createHmac, randomBytes } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client, type QueryResultRow } from 'pg';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

export const DEFAULT_DATABASE_URL =
  process.env.DATABASE_URL ?? 'postgresql://postgres@/postgres?host=/tmp/pgdata';

export const MIGRATIONS_DIR = path.join(ROOT, 'supabase', 'migrations');
export const BOOTSTRAP_FILE = path.join(ROOT, 'supabase', 'local', 'bootstrap_local.sql');

export type Role = 'anon' | 'authenticated' | 'service_role';

export interface JwtClaims {
  sub?: string;
  role?: string;
  aal?: 'aal1' | 'aal2';
}

let resetCount = 0;

/** Recria banco do zero: bootstrap local + todas as migrações versionadas. */
export async function resetDatabase(): Promise<void> {
  const client = new Client({ connectionString: DEFAULT_DATABASE_URL });
  await client.connect();
  try {
    await client.query('drop schema if exists public cascade');
    await client.query('drop schema if exists auth cascade');
    await client.query('create schema public');
    await client.query(readFileSync(BOOTSTRAP_FILE, 'utf8'));

    for (const file of migrationFiles()) {
      await client.query(readFileSync(path.join(MIGRATIONS_DIR, file), 'utf8'));
    }
    resetCount += 1;
  } finally {
    await client.end();
  }
}

export function migrationFiles(): string[] {
  return readdirSync(MIGRATIONS_DIR)
    .filter((file) => file.endsWith('.sql'))
    .sort();
}

export function migrationsApplied(): number {
  return resetCount;
}

export async function connect(): Promise<Client> {
  const client = new Client({ connectionString: DEFAULT_DATABASE_URL });
  await client.connect();
  return client;
}

export interface RunOptions {
  role?: Role;
  claims?: JwtClaims;
}

/**
 * Executa SQL com o papel e as claims de JWT da requisição. Sempre em transação:
 * `set local` não vaza para outras execuções.
 */
export async function runAs<T extends QueryResultRow = QueryResultRow>(
  sql: string,
  values: unknown[] = [],
  options: RunOptions = {},
): Promise<T[]> {
  const client = await connect();
  try {
    await client.query('begin');
    if (options.role) {
      await client.query(`set local role ${options.role}`);
    }
    if (options.claims) {
      await client.query('select set_config($1, $2, true)', [
        'request.jwt.claims',
        JSON.stringify(options.claims),
      ]);
    }
    const result = await client.query<T>(sql, values as never[]);
    await client.query('commit');
    return result.rows;
  } catch (error) {
    try {
      await client.query('rollback');
    } catch {
      /* transação já encerrada */
    }
    throw error;
  } finally {
    await client.end();
  }
}

/** Executa SQL como superusuário local (equivalente a service_role/server-side). */
export async function runSql<T extends QueryResultRow = QueryResultRow>(
  sql: string,
  values: unknown[] = [],
): Promise<T[]> {
  return runAs<T>(sql, values);
}

export async function sqlValue<T>(sql: string, values: unknown[] = []): Promise<T> {
  const rows = await runSql<Record<string, T>>(sql, values);
  const first = rows[0];
  return Object.values(first)[0] as T;
}

// ---------------------------------------------------------------------------
// Criptografia/segredos usados pelos testes (mesmas primitivas da Edge Function)
// ---------------------------------------------------------------------------

export function sha256Hex(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

export function hmacHex(key: string, value: string): string {
  return createHmac('sha256', key).update(value, 'utf8').digest('hex');
}

export function randomToken(bytes = 32): string {
  return randomBytes(bytes).toString('base64url');
}

export function fakeCiphertext(label: string): Buffer {
  // Ciphertext opaco de tamanho realista; os testes de banco não decifram nada.
  return randomBytes(48 + label.length);
}

/** Ciphertext no formato que as RPCs recebem (base64). */
export function fakeCiphertextB64(label: string): string {
  return fakeCiphertext(label).toString('base64');
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

export interface SeedOptions {
  priceCents?: number;
  costCents?: number;
  maxQuantity?: number;
  stockUnits?: number;
  active?: boolean;
}

export interface Seed {
  productId: string;
  slug: string;
  units: string[];
}

export async function seedProduct(options: SeedOptions = {}): Promise<Seed> {
  const slug = `produto-${randomBytes(4).toString('hex')}`;
  const rows = await runSql<{ id: string }>(
    `insert into public.products (
       slug, name, short_description, description, category_id, price_cents, cost_cents,
       instructions, max_quantity_per_order, is_active, access_validity_label
     ) values ($1, $2, 'desc curta', 'desc longa', 'music', $3, $4, 'Instruções de uso', $5, $6, '30 dias')
     returning id`,
    [
      slug,
      `Produto ${slug}`,
      options.priceCents ?? 5000,
      options.costCents ?? 1000,
      options.maxQuantity ?? 1,
      options.active ?? true,
    ],
  );
  const productId = rows[0].id;
  const units: string[] = [];

  for (let index = 0; index < (options.stockUnits ?? 0); index += 1) {
    units.push(await seedStockUnit(productId, `conta${index}@exemplo.com`, `senha-${index}`));
  }

  return { productId, slug, units };
}

export async function seedStockUnit(
  productId: string,
  email: string,
  password: string,
): Promise<string> {
  const rows = await runSql<{ id: string }>(
    `insert into public.stock_units (product_id, account_email_enc, account_password_enc, credential_fingerprint)
     values ($1, $2, $3, $4) returning id`,
    [productId, fakeCiphertext(email), fakeCiphertext(password), hmacHex('test-fingerprint-key', `${email}:${password}`)],
  );
  return rows[0].id;
}

export async function seedAdmin(role: 'owner' | 'admin' = 'admin'): Promise<string> {
  const userRows = await runSql<{ id: string }>(
    `insert into auth.users (email) values ($1) returning id`,
    [`admin-${randomBytes(4).toString('hex')}@prime.invalid`],
  );
  const userId = userRows[0].id;
  await runSql(`insert into public.admin_users (user_id, display_name, role) values ($1, $2, $3)`, [
    userId,
    `Admin ${role}`,
    role,
  ]);
  return userId;
}

export interface OrderResult {
  order_id: string;
  reference: string;
  status: string;
  payment_status: string;
  delivery_status: string;
  quantity: number;
  total_cents: number;
  reservation_expires_at: string;
  idempotent_replay: boolean;
}

export const ADMIN_KEY = 'test-webhook-secret';

export async function createOrder(
  productId: string,
  quantity = 1,
  options: { idempotencyKey?: string | null; clientToken?: string } = {},
): Promise<{ order: OrderResult; clientToken: string; tokenHash: string }> {
  const clientToken = options.clientToken ?? randomToken();
  const tokenHash = sha256Hex(clientToken);
  const rows = await runSql<{ result: OrderResult }>(
    `select public.create_order($1, $2, $3, $4) as result`,
    [productId, quantity, options.idempotencyKey ?? null, tokenHash],
  );
  return { order: rows[0].result, clientToken, tokenHash };
}
