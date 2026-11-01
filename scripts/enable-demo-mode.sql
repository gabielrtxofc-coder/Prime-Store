-- ============================================================================
-- LIGAR O MODO DE PAGAMENTO DEMONSTRATIVO — SOMENTE NO SANDBOX
-- ============================================================================
-- ⚠️  NÃO EXECUTE ESTE ARQUIVO EM PRODUÇÃO.
--
-- Este é um script OPERACIONAL (não é migração): as migrações 0026–0029 criam
-- a estrutura com o modo DESLIGADO, e é aqui que ele é ligado — de forma
-- explícita, auditável e reversível — apenas no projeto de sandbox
-- `prime-store-sandbox` (`eorlmqolbknrplvdbbtl`).
--
-- Pré-requisitos para o modo funcionar de ponta a ponta:
--   1. este script aplicado (chave `demo_payments_enabled`);
--   2. secret `DEMO_PAYMENT_ENABLED=true` na Edge Function;
--   3. ref do projeto listado em `DEMO_ALLOWED_PROJECT_REFS`;
--   4. produtos marcados como `is_demo` (feito abaixo para os de exemplo);
--   5. estoque fictício semeado (ação `seed` da função `demo-payment`).
--
-- Para DESLIGAR (recomendado ao sair do sandbox ou antes de qualquer cobrança
-- real), basta rodar:
--     update public.app_settings set value = 'false'::jsonb where key = 'demo_payments_enabled';
--     -- e definir DEMO_PAYMENT_ENABLED=false nos secrets da função.

begin;

-- 1. Liga a aprovação simulada no banco.
update public.app_settings
   set value = 'true'::jsonb,
       updated_at = now()
 where key = 'demo_payments_enabled';

-- 2. Marca como demonstrativos apenas os produtos de exemplo deste sandbox.
--    Nenhum produto real é marcado.
update public.products
   set is_demo = true,
       updated_at = now()
 where slug like 'produto-exemplo%'
   and archived_at is null;

commit;

-- 3. Conferência (deve retornar modo_ligado = true e os produtos de exemplo).
select
  public.demo_payments_enabled() as modo_ligado,
  (select string_agg(slug || ' (is_demo=' || is_demo || ')', ', ' order by slug)
     from public.products where is_demo) as produtos_demonstrativos,
  (select count(*) from public.stock_units where is_demo) as unidades_ficticias;
