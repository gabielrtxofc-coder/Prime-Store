# Evidência 01 — Migrações aplicadas no sandbox

Projeto confirmado antes de cada operação: **`eorlmqolbknrplvdbbtl`**
(`prime-store-sandbox`, `sa-east-1`, `ACTIVE_HEALTHY`). Nenhuma outra instância foi tocada.

`list_migrations` após a sessão (23 registros):

```
20261031003135  foundation
20261031003146  admin_authorization
20261031003153  products_catalog
20261031003159  stock_units
20261031003206  orders_reservations
20261031003213  payments_events
20261031003218  deliveries
20261031003227  reservation_core
20261031003241  orders_api
20261031003257  payments_api
20261031003313  admin_api
20261031003328  admin_api_import_orders
20261031003339  admin_api_delivery_refunds
20261031003349  grants_rls_public_catalog
20261031050605  idempotencia_pedido          <-- missão 03 (0017)
20261031050611  status_disputa               <-- missão 03 (0018)
20261031050641  chargeback_x_reembolso       <-- missão 03 (0019)
20261031050649  search_path_funcoes          <-- missão 03 (0020)
20261031050653  indices_operacionais         <-- missão 03 (0021)
20261031050700  privilegios_finais           <-- missão 03 (0022)
20261031050705  cofre_chave_criptografia     <-- missão 03 (0023)
20261031050713  status_sem_ciphertext        <-- missão 03 (0024)
2026103105xxxx  indices_redundantes          <-- missão 03 (0025, remoção de duplicados)
```

Observação de método: `0018` (`alter type ... add value 'disputed'`) foi aplicada em
migração **separada** da `0019`, porque o PostgreSQL não permite usar um valor de enum
recém-criado na mesma transação.

## Estado estrutural medido depois das migrações

```sql
select
  (select count(*) from pg_proc p join pg_namespace n on n.oid=p.pronamespace
     where n.nspname='public' and p.prosecdef)                                     as secdef,          -- 41
  (select count(*) from pg_proc p join pg_namespace n on n.oid=p.pronamespace
     where n.nspname='public' and p.proconfig is null)                             as sem_search_path, -- 0
  (select count(*) from pg_proc p join pg_namespace n on n.oid=p.pronamespace
     where n.nspname='public' and has_function_privilege('authenticated', p.oid, 'execute')) as exec_auth, -- 23
  (select count(*) from pg_proc p join pg_namespace n on n.oid=p.pronamespace
     where n.nspname='public' and has_function_privilege('anon', p.oid, 'execute'))          as exec_anon, -- 0
  (select count(*) from pg_class c join pg_namespace n on n.oid=c.relnamespace
     where n.nspname='public' and c.relkind='r' and not c.relrowsecurity)          as sem_rls,         -- 0
  (select count(*) from pg_indexes where schemaname='public'
     and indexname like 'stock_units_%idx')                                        as indices_stock,   -- 4 (era 6 antes da 0025)
  (select count(*) from pg_type t join pg_enum e on e.enumtypid=t.oid
     where t.typname='order_status' and e.enumlabel='disputed')                    as enum_disputed,   -- 1
  (select count(*) from vault.secrets where name='prime_store_encryption_key')      as cofre_chave;     -- 1
```

Antes da missão 03 (auditoria): `secdef=38`, `sem_search_path=3`, `exec_auth=22`.
Depois: `secdef=41` (novas `admin_resolve_dispute`, `get_secret_material`,
`get_delivery_token_enc`), `sem_search_path=0`, `exec_auth=23`.

## Segunda passada de verificação (após a 0025)

```
rls_desabilitado ................. 0
funcoes_sem_search_path .......... 0
security_definer ................. 41
secdef_sem_search_path ........... 0
funcoes_exec_anon ................ 0
funcoes_exec_authenticated ....... 23
tabelas_com_select_anon .......... 0
extensoes_no_public .............. 0
fks_sem_indice ................... 0
indices_duplicados ............... 0   (era 4 pares: 3 removidos + 1 recriado)
politicas (qualquer) ............. 0
vault_chave ...................... 1
```

Os "4 pares duplicados" da primeira medição eram: `stock_units_sold_order_idx` =
`stock_units_order_idx`, `stock_units_product_status_idx` = `stock_units_status_idx`,
`deliveries_order_idx` ⊂ `deliveries_order_id_key` e o falso positivo
`stock_units_available_idx` × `stock_units_status_idx` (colunas diferentes). Os três
primeiros foram removidos pela migração `0025`; nenhum índice foi removido por "estar
sem uso".

## Paridade local × remoto

O banco local é reconstruído do zero (`supabase/local/bootstrap_local.sql` + as 24
migrações) e comparado ao remoto por impressão digital estrutural (tabelas, colunas,
funções + `search_path`, índices, enums, constraints, RLS). Na missão 02 a impressão
coincidiu (`parts=413`, `md5=026951e28df7245ab74de205c21190c4`); nesta missão os
números acima foram medidos dos dois lados e coincidem nos invariantes estruturais
(41 `SECURITY DEFINER`, 0 funções sem `search_path`, 0 tabelas sem RLS, enum `disputed`).
