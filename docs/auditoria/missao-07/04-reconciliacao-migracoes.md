# Missão 07 — Etapa 04: reconciliação das migrações

> Diagnóstico do descompasso entre o histórico de migrações registrado no projeto
> `prime-store-sandbox` (`eorlmqolbknrplvdbbtl`) e os arquivos do repositório.
> **Nenhum registro foi apagado, renomeado ou reescrito**, nenhuma migração
> destrutiva foi executada e nada foi publicado em produção.

## 1. O sintoma

| Origem | Quantidade | Formato |
| --- | --- | --- |
| `supabase_migrations.schema_migrations` no sandbox | **27 registros** | `20261031003135` … `20261031153926` |
| `supabase/migrations/` no repositório | **30 arquivos** (na época do reconhecimento) | `20261031120000_0001_…` … `20261031140000_0030_…` |

Os dois conjuntos não têm nenhuma versão em comum, o que sugeriria um schema
divergente. A verificação abaixo mostra que **o schema não diverge**.

## 2. Método

O banco local foi reconstruído do zero (base vazia `pg30`) aplicando
`supabase/local/bootstrap_local.sql` e **somente** os 30 arquivos
`0001`–`0030` — sem `0031`/`0032`, que são desta missão. Em seguida o resultado
foi comparado com o sandbox por inventário estrutural e por privilégios.

## 3. Resultado estrutural

Contagem por tipo de objeto e hash do conjunto (nome canônico de cada objeto),
calculados pela mesma consulta nos dois bancos:

| Tipo | Local (30 arquivos) | Sandbox | Hash |
| --- | --- | --- | --- |
| tabela | 17 | 17 | `22c7f302…` idêntico |
| coluna | 174 | 174 | `7274afb9…` idêntico |
| função | 47 | 47 | `72a4db5b…` idêntico |
| enum | 6 | 6 | `5912a67f…` idêntico |
| índice | 56 | 56 | `af3ae5ca…` idêntico |
| trigger | 6 | 6 | `2dcd8cd7…` idêntico |
| view | 1 | 1 | `e5518845…` idêntico |
| RLS ligado | 17 | 17 | `3aad08db…` idêntico |

`constraint`: **98 × 98 com diff vazio** na comparação das três colunas
(`nome | tabela | tipo`). A contagem bruta local aparece maior (225) porque o
PostgreSQL 18 registra `NOT NULL` em `pg_constraint` (`contype = 'n'`, 127
linhas) e o PostgreSQL 17 do sandbox não — é diferença de versão do catálogo,
não de schema.

## 4. Resultado de privilégios

| Consulta | Local | Sandbox |
| --- | --- | --- |
| Tabelas/view legíveis por `anon` | nenhuma | nenhuma |
| Funções executáveis por `anon` | nenhuma | nenhuma |
| Tabelas/view legíveis por `authenticated` | nenhuma | nenhuma |
| Funções executáveis por `authenticated` | 23 (todas `admin_*` + `is_admin`) | 23, mesma lista |
| Tabelas/view legíveis por `service_role` | 18 | 18 |
| Tabelas com RLS ligado | 17 | 17 |

Ou seja: o endurecimento de acesso aplicado na migração `0030`
(`public_catalog` sem `SELECT` para `anon`) **está presente no sandbox**.

## 5. Conclusão

**As 27 migrações registradas no sandbox produzem exatamente o mesmo schema dos
30 arquivos do repositório.** A divergência é de *linhagem* (nomes e carimbos de
tempo), não de conteúdo:

- os 14 primeiros registros remotos (`foundation` … `grants_rls_public_catalog`,
  de `20261031003135` a `20261031003349`) agrupam em 14 arquivos o que o
  repositório organiza em 15 (`0001_tipos_enums` … `0015_comentarios`) — os
  nomes remotos descrevem áreas funcionais, os do repositório descrevem o passo;
- os 9 seguintes (`idempotencia_pedido` … `indices_redundantes`,
  `20261031050605`–`20261031051427`) correspondem 1:1 aos arquivos
  `0017`–`0025`;
- os 4 últimos (`modo_demonstrativo_estrutura` … `demo_semeadura_privilegios`,
  `20261031153900`–`20261031153926`) correspondem 1:1 aos arquivos `0026`–`0029`;
- o conteúdo equivalente ao arquivo `0030` já está contido no schema remoto
  (privilégios conferem), sem registro próprio.

O repositório foi, portanto, renumerado/normalizado depois que o sandbox já
existia. A hipótese de schema desatualizado está **descartada por medição**.

## 6. O que foi feito e o que não foi

Feito:

- diagnóstico acima, com evidência reproduzível;
- nenhuma alteração nos 27 registros do sandbox;
- nenhuma migração destrutiva;
- as **novas** migrações desta missão foram renomeadas para carimbos de tempo
  posteriores ao último registro remoto, para que a ordem cronológica continue
  coerente para quem aplicar o histórico:
  - `20261031150000_0031_…` → `20261101090000_0031_agendamento_expiracao_reservas.sql`
  - `20261031151000_0032_…` → `20261101091000_0032_limite_requisicoes.sql`
  
  (são arquivos novos, nunca aplicados em nenhum banco; renomear não altera
  histórico).

Não feito, por decisão explícita:

- **não** inserir 30 registros em `schema_migrations` para "casar" a linhagem:
  seria fabricar histórico que nunca existiu;
- **não** apagar nem renomear os 27 registros existentes;
- **não** resetar o banco do sandbox para reaplicar `0001`–`0032`: é operação
  destrutiva, exigiria autorização e apagaria dados de teste e auditoria.

Consequência prática: `supabase db push` **não** deve ser usado neste projeto
enquanto a linhagem não for reconciliada por decisão do responsável — ele
tentaria reaplicar os 30 arquivos. A publicação das migrações desta missão é
feita aplicando o SQL e registrando **apenas** as versões efetivamente aplicadas
(`0031`, `0032`), com comprovação nos objetos criados (ver relatório, seção de
integração). O reparo definitivo do histórico fica registrado como pendência que
depende de decisão externa (reset controlado ou adoção de `--include-all` com
revisão linha a linha).
