-- ============================================================================
-- 0026 — MODO DE PAGAMENTO DEMONSTRATIVO (sandbox)
-- ============================================================================
-- Contexto: a integração real com o Mercado Pago está implementada, mas as
-- credenciais de sandbox ainda não existem. Para que o fluxo completo
-- (pedido → reserva → aprovação → entrega → link privado) possa ser exercitado
-- e demonstrado, a V1 ganha um modo de pagamento SIMULADO.
--
-- Regras de projeto deste modo:
--
--   1. DESLIGADO POR PADRÃO. A chave `demo_payments_enabled` nasce `false`.
--      Só o script operacional `scripts/enable-demo-mode.sql`, executado
--      exclusivamente no projeto de sandbox, a liga. Nenhuma migração liga o
--      modo — assim um `db push` em produção não ativa nada.
--   2. A aprovação é decidida NO BANCO, nunca pelo navegador: a função
--      `demo_approve_payment` confere prova de posse (hash do token privado),
--      validade da reserva e elegibilidade do produto.
--   3. SÓ ESTOQUE FICTÍCIO. A aprovação simulada é recusada se alguma unidade
--      reservada não estiver marcada como `is_demo`. Credencial real importada
--      no ambiente nunca é entregue por simulação.
--   4. REAPROVEITA O FLUXO REAL: `demo_approve_payment` chama
--      `apply_payment_status('approved')`, que é o mesmo caminho do webhook
--      do Mercado Pago (consome reserva, vincula unidades, cria a entrega).
--   5. REGISTRA A ORIGEM: o pagamento fica com `provider = 'demo'` e o pedido
--      recebe o evento `demo_payment_approved`. Nada é apresentado como PIX.
--
-- O modo é removível sem migração destrutiva: basta desligar a chave em
-- `app_settings` (e/ou `DEMO_PAYMENT_ENABLED=false` na Edge Function).
--
-- Esta migração apenas CRIA a estrutura (desligada). A ordem é:
--   0026 estrutura · 0027 catálogo/pedido · 0028 aprovação · 0029 semeadura.

-- ---------------------------------------------------------------------------
-- 1. Marcadores de demonstração
-- ---------------------------------------------------------------------------
alter table public.products
  add column if not exists is_demo boolean not null default false;

alter table public.stock_units
  add column if not exists is_demo boolean not null default false;

comment on column public.products.is_demo is
  'Produto de demonstração: aceita aprovação de pagamento simulada no sandbox.';
comment on column public.stock_units.is_demo is
  'Unidade com credencial fictícia, criada para demonstração. Nunca é entregue por simulação se a coluna for false.';

-- Configuração do modo (nasce desligada em qualquer ambiente).
insert into public.app_settings (key, value, description)
values (
  'demo_payments_enabled',
  'false'::jsonb,
  'Habilita a aprovação de pagamento SIMULADA no sandbox. Nunca ligar em produção.'
)
on conflict (key) do nothing;

-- O provedor de pagamento passa a admitir a origem `demo`, para que o registro
-- fique rastreável e não se confunda com uma cobrança real.
alter table public.payments drop constraint if exists payments_provider_check;
alter table public.payments
  add constraint payments_provider_check check (provider in ('mercado_pago', 'demo'));

alter table public.payment_events drop constraint if exists payment_events_provider_check;
alter table public.payment_events
  add constraint payment_events_provider_check check (provider in ('mercado_pago', 'demo'));

-- ---------------------------------------------------------------------------
-- 2. Leitura da chave do modo (uma única fonte de verdade)
-- ---------------------------------------------------------------------------
create or replace function public.demo_payments_enabled()
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select coalesce(
    (select s.value = 'true'::jsonb from public.app_settings s where s.key = 'demo_payments_enabled'),
    false
  );
$$;

comment on function public.demo_payments_enabled() is
  'true somente quando o modo de pagamento demonstrativo está ligado no banco.';

-- ---------------------------------------------------------------------------
-- 3. Catálogo público informa a origem do produto (para a interface rotular)
-- ---------------------------------------------------------------------------
create or replace view public.public_catalog as
select
  p.id,
  p.slug,
  p.name,
  p.short_description,
  p.description,
  p.image_url,
  p.category_id,
  c.label as category_label,
  p.modality,
  p.period,
  p.price_cents,
  p.access_validity_days,
  p.access_validity_label,
  p.instructions,
  p.conditions,
  p.monogram,
  p.theme,
  p.max_quantity_per_order,
  p.is_featured,
  p.created_at,
  p.updated_at,
  coalesce(s.available_units, 0) as available_units,
  coalesce(s.available_units, 0) > 0 as is_available,
  p.is_demo
from public.products p
join public.product_categories c on c.id = p.category_id and c.is_active
left join (
  select su.product_id, count(*) as available_units
  from public.stock_units su
  where su.status = 'available'
  group by su.product_id
) s on s.product_id = p.id
where p.is_active and p.archived_at is null;

comment on view public.public_catalog is
  'Única superfície de leitura pública do catálogo. Sem custo, sem credenciais, sem identificadores internos de estoque.';

