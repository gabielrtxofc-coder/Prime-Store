# Evidência 05 — Smoke test na base remota (SQL real)

Projeto `eorlmqolbknrplvdbbtl`. Fixtures criadas para o teste (`smoke-hardening-03`,
2 unidades com ciphertext fictício) e **removidas ao final** — verificação final:
`produto_restante = 0`, `pedido_restante = 0`.

## 1. Criação idempotente

```sql
select public.create_order(<produto>, 1, 'smoke-hardening-key-0001', repeat('a1',32));
```
→ `status: pending_payment`, `reference: PS-EF6GMS`, `idempotent_replay: false`,
`reservation_expires_at: 2026-10-31T05:37:36Z` (30 minutos).

Repetição idêntica:
→ mesmo `order_id c3b92b64-…`, mesma `reference`, `idempotent_replay: true`.

## 2. Tentativa de sequestro (mesma chave, outro token)

```
ERROR: P0001: idempotency_conflict
CONTEXT: PL/pgSQL function create_order(uuid,integer,text,text) line 46 at RAISE
```

Estado depois da tentativa:

```sql
select o.reference, o.status, o.client_token_hash = repeat('a1',32) as token_original_preservado,
       (select count(*) from public.orders x where x.idempotency_key='smoke-hardening-key-0001') as pedidos_com_a_chave
from public.orders o where o.idempotency_key='smoke-hardening-key-0001';
```
→ `PS-EF6GMS | pending_payment | token_original_preservado = true | pedidos_com_a_chave = 1`

## 3. Pagamento aprovado

```sql
select public.apply_payment_status(<pedido>, 'SMOKE-MP-1', 'approved', 'accredited', 4990,
        repeat('e5',32), encode(decode(repeat('ab',40),'hex'),'base64'));
```
→ `{"result":"approved","order_status":"paid","payment_status":"approved","delivery_status":"ready"}`

## 4. Chargeback (não é reembolso)

```sql
select public.apply_payment_status(<pedido>, 'SMOKE-MP-1', 'charged_back', 'chargeback', 4990, null, null);
```

| order_status | payment_status | delivery_status | link_status | reembolsos processados | eventos chargeback | eventos reembolso |
| --- | --- | --- | --- | --- | --- | --- |
| `disputed` | `charged_back` | `ready` | **`active`** | **0** | 1 | 0 |

## 5. Reembolso posterior

| order_status | payment_status | delivery_status | link_status | eventos chargeback | eventos reembolso |
| --- | --- | --- | --- | --- | --- |
| `refunded` | `refunded` | `revoked` | `revoked` | 1 | 1 |

## 6. `get_order_status` não devolve ciphertext

```sql
select jsonb_object_keys(public.get_order_status(<pedido>, repeat('a1',32))->'delivery');
```
→ `id`, `status`, `created_at`, `link_ready`, `revoked_at` — **sem `token_enc`**.

## 7. Privilégios do RPC de ciphertext

```sql
select has_function_privilege('anon','public.get_delivery_token_enc(uuid,text)','execute')          -- false
     , has_function_privilege('authenticated','public.get_delivery_token_enc(uuid,text)','execute') -- false
     , has_function_privilege('service_role','public.get_delivery_token_enc(uuid,text)','execute')  -- true
     , has_function_privilege('authenticated','public.create_order(uuid,integer,text,text)','execute'); -- false
```

## 8. Cofre da chave de criptografia

```sql
select (public.get_secret_material('prime_store_encryption_key') is not null) as cofre_tem_segredo,
       length(public.get_secret_material('prime_store_encryption_key'))          as tamanho_base64,
       (select count(*) from supabase_migrations.schema_migrations)              as migracoes;
-- cofre_tem_segredo = true | tamanho_base64 = 44 | migracoes = 23
```

44 caracteres base64 = 32 bytes (AES-256), gerados dentro do banco. O valor não foi
lido nem registrado em lugar algum; só o tamanho foi verificado.

## 9. Limpeza

```sql
delete delivery_units, deliveries, order_events, payments, stock_reservation_units,
       stock_reservations, payment_events(data_id='SMOKE-MP-1'), stock_units,
       orders, product_price_history, products
→ produto_restante = 0, pedido_restante = 0
```

> O que este teste **não** prova: nada sobre HTTP/Edge Functions (as chamadas foram
> feitas direto no PostgreSQL) e nada sobre o Mercado Pago real (nenhuma credencial de
> teste disponível). Essas duas lacunas estão listadas como pendência no relatório.
