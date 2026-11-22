/** Chromium + build Vite + handlers reais + PG descartável. Sem servidor externo. */
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { randomBytes, randomUUID } from 'node:crypto';
import { chromium } from 'playwright-core';
import { build } from 'vite';
import { connect, resetDatabase, runAs, seedAdmin, seedProduct, sqlValue } from '../db/helpers';
import { createPgRpc } from '../db/pgRpc';
import { createFakeWyvi, signWyviEvent, signedWyviRequest } from '../unit/fakeWyvi';
import { createDeps } from '../../supabase/functions/_shared/deps';
import { handleCatalog } from '../../supabase/functions/_shared/handlers/catalog';
import { handleCreateOrder } from '../../supabase/functions/_shared/handlers/createOrder';
import { handleOrderStatus } from '../../supabase/functions/_shared/handlers/orderStatus';
import { handleWyviWebhook } from '../../supabase/functions/_shared/handlers/wyviWebhook';
import { processWyviQueueForOrder } from '../../supabase/functions/_shared/wyviEvents';

const origin = 'https://store.test';
Object.assign(process.env, { VITE_BACKEND_ENABLED: 'true', VITE_SUPABASE_URL: origin,
  VITE_BACKEND_URL: `${origin}/functions/v1`, VITE_SUPABASE_ANON_KEY: 'fixture', VITE_ADMIN_DEMO: 'false' });
const outDir = 'node_modules/.cache/store-e2e';
await build({ envDir: false, build: { outDir, emptyOutDir: true } });
await resetDatabase();
const product = await seedProduct({stockUnits: 3, maxQuantity: 3});
const admin = await seedAdmin();
const fake = createFakeWyvi();
const config = {apiKey:'wy_test_fixture', baseUrl:'https://api.wyvipay.test', fetchImpl:fake.fetchImpl};
const secret = randomBytes(32).toString('hex');
const key = randomBytes(32).toString('base64');
const db = await connect();
const rpc = createPgRpc(db);
const deps = createDeps({config:{supabaseUrl:origin, serviceRoleKey:'fixture', anonKey:'fixture', storeUrl:origin,
  wyviEnvironment:'test', wyviApiKey:config.apiKey, wyviApiBase:config.baseUrl, wyviWebhookSecret:secret, encryptionKey:key},
  rpc, serviceRpc:rpc, fetchImpl:fake.fetchImpl, resolveEncryptionKey:async()=>key});
const browser = await chromium.launch({executablePath:process.env.CHROMIUM_PATH});
try {
  const page = await browser.newPage();
  page.setDefaultTimeout(8000);
  const handlers = new Map(Object.entries({'catalog':handleCatalog,'create-order':handleCreateOrder,'order-status':handleOrderStatus}));
  await page.route('**/*', async route => {
    const req = route.request();
    const u = new URL(req.url());
    if (u.origin !== origin) return route.abort();
    if (u.pathname.startsWith('/functions/')) {
      const handler = handlers.get(u.pathname.split('/').pop()!);
      if (!handler) return route.abort();
      const res = await handler(new Request(u,{method:req.method(),headers:req.headers(),body:req.postData() ?? undefined}),deps);
      return route.fulfill({status:res.status,contentType:'application/json',body:await res.text()});
    }
    if (u.pathname.startsWith('/assets/')) return route.fulfill({body:await readFile(outDir+u.pathname),contentType:u.pathname.endsWith('.js')?'text/javascript':'text/css'});
    return route.fulfill({body:await readFile(outDir+'/index.html'),contentType:'text/html'});
  });
  await page.goto(origin);
  await page.getByRole('link',{name:/Explorar catálogo/i}).click();
  await page.getByRole('link',{name:`Produto ${product.slug}`,exact:true}).click();
  await page.getByRole('button',{name:'Aumentar quantidade do produto'}).click();
  await page.getByRole('button',{name:/Adicionar ao carrinho/i}).click();
  await page.goto(origin+'/carrinho');
  await page.getByRole('link',{name:/Continuar para finalizar/i}).click();
  await page.getByLabel('Nome completo').fill('Pessoa Teste');
  await page.getByLabel('E-mail',{exact:true}).fill('teste@example.invalid');
  await page.getByLabel('Confirme seu e-mail').fill('teste@example.invalid');
  await page.getByRole('checkbox').check();
  await page.getByRole('button',{name:/Finalizar pedido/i}).click();
  await page.waitForURL('**/pagamento');
  const {rows:[payment]} = await db.query('select order_id, provider_payment_id from public.payments');
  assert(payment.provider_payment_id);
  fake.setSituacao(payment.provider_payment_id,'concluida');
  const event = signWyviEvent({secret,evento:'cobranca.paga',deliveryId:randomUUID(),dados:{txid:payment.provider_payment_id, referencia:payment.order_id,valor_centavos:10000}});
  assert.equal((await handleWyviWebhook(signedWyviRequest(event),deps)).status,200);
  await processWyviQueueForOrder(deps,config,payment.order_id);
  await page.reload();
  await page.getByText('Pagamento confirmado',{exact:true}).first().waitFor();
  assert.equal(Number(await sqlValue("select count(*) from public.stock_units where status='sold'")),2);
  const orders = await runAs('select public.admin_list_orders() as orders',[],{role:'authenticated',claims:{sub:admin,role:'authenticated',aal:'aal2'}});
  assert(JSON.stringify(orders).includes(payment.order_id));
  console.log('PASS: catálogo → carrinho → PIX → webhook → confirmação, estoque e consulta administrativa');
} finally {await browser.close(); await db.end();}
