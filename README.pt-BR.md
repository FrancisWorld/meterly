# Meterly

[English](README.md)

[![ci](https://github.com/FrancisWorld/meterly/actions/workflows/ci.yml/badge.svg)](https://github.com/FrancisWorld/meterly/actions/workflows/ci.yml)
[![license: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

**Motor de cobrança por uso em Bun, Hono e PostgreSQL: ingestão idempotente de alto volume, watermark para eventos atrasados, preços escalonados/por volume/por pacote com aritmética exata, faturas com créditos e rateio (proration), e sincronização com o Stripe por outbox transacional.**

## Por que existe / o que é difícil

Cobrança por uso parece "some os eventos e multiplique pelo preço". O que complica de verdade:

- **Eventos são reenviados, duplicados e chegam atrasados.** A ingestão precisa ser idempotente por chave, perceber uma chave reutilizada com payload *diferente* e decidir o que fazer com um evento de um período já faturado.
- **Dinheiro precisa ser exato.** Quantidades passam de 2^53, preços unitários são frações de centavo (`0.0004`) e faixas têm taxa fixa. Tudo aqui é `bigint` sobre decimais de ponto fixo, com um único arredondamento por linha.
- **Fechar o período concorre com a ingestão.** Um evento deve cair na fatura ou no próximo período; nunca nos dois, nunca em nenhum.
- **Falar com um provedor de pagamento é um problema de sistemas distribuídos.** Um timeout depois de o Stripe já ter criado a fatura não pode gerar uma segunda; um evento de fatura pode chegar antes de sabermos o id no Stripe, ou fora de ordem.

O Stripe fica atrás da interface `StripeGateway`. O repositório traz um fake determinístico em memória e **nenhum cliente real do Stripe**: nada aqui chama o Stripe. As assinaturas de webhook são geradas localmente nos testes, com o mesmo esquema documentado pelo Stripe (`t=...,v1=HMAC-SHA256`).

## Arquitetura

```mermaid
flowchart LR
  client([Cliente da API]) -->|Bearer key| api[API Hono]
  api --> ing[Ingestão]
  api --> inv[Faturamento]
  api --> cat[Catálogo / créditos / assinaturas]
  ing -->|INSERT em lote ... ON CONFLICT| pg[(PostgreSQL)]
  inv -->|FOR UPDATE no cliente, 1 transação| pg
  cat --> pg
  inv -->|mesma transação| ob[(outbox)]
  pg --- ob
  ob -->|"lease: FOR UPDATE SKIP LOCKED"| worker[Worker do outbox]
  worker -->|chave de idempotência| gw{{StripeGateway}}
  gw --> fake[FakeStripe]
  stripe([Eventos do Stripe]) -->|"Stripe-Signature"| wh[Receptor de webhook]
  wh -->|verifica, deduplica, ordena por created| pg
  worker -->|vincula o id do Stripe, reaplica eventos retidos| pg
```

```
src/domain      puro, sem I/O: preços, rateio, períodos, cálculo da fatura, ordenação de eventos
src/services    um módulo por responsabilidade; todo o SQL fica aqui
src/stripe      interface do gateway, fake determinístico, verificação de assinatura
src/worker      worker do outbox (lease, backoff, dead-letter)
src/http        app Hono: autenticação, validação (zod), rotas, views
migrations      SQL puro, aplicado por um runner com advisory lock
```

## Início rápido

Tudo abaixo foi executado em um notebook Apple Silicon (8 GB) com Docker (Colima).

```bash
docker compose up -d --build                    # PostgreSQL + API na porta 3000
docker compose exec app bun src/cli/create-tenant.ts acme   # imprime tenant id e a chave de API (mostrada uma vez)

# em um checkout com bun instalado:
bun install
export API_KEY=mtk_...                          # do comando anterior
export STRIPE_WEBHOOK_SECRET=replace-me-with-a-long-random-secret   # padrão do compose
scripts/demo.sh                                 # catálogo -> ingestão -> prévia -> fechamento -> push ao Stripe -> webhook
docker compose down -v
```

Saída real de `scripts/demo.sh` (resumida):

```text
# ingest (twice: the replay must be all duplicates)
{"accepted":5,"duplicate":0,"rejected":0,"conflict":0}
{"accepted":0,"duplicate":5,"rejected":0,"conflict":0}
# invoice preview
  lines: Base fee 4900 | active_users (unique) qty 2 -> 1500 | api_calls (sum) qty 12000 -> 4900
  "subtotal": "11300", "amount_due": "11300"
# finalize
{ "number": "1", "status": "open", "amount_due": "11300", "stripe_invoice_id": null }
stripe invoice: in_fake_3402ad38e4a0f191            # o worker do outbox enviou
# signed webhook: invoice.paid
{"received":true,"outcome":"applied"}
{"received":true,"outcome":"duplicate"}
{"error":{"code":"invalid_signature","message":"webhook signature verification failed","details":{"reason":"no_matching_signature"}}}
{ "number": "1", "status": "paid", "amount_due": "11300", "stripe_invoice_id": "in_fake_3402ad38e4a0f191" }
```

As 12 000 chamadas no modelo `graduated`: 1 000 grátis + 9 000 x 0,5 + 2 000 x 0,2 = 4 900.

### API

Todas as rotas `/v1` exigem `Authorization: Bearer <chave>`; o tenant vem da chave (só o SHA-256 é armazenado). Quantidades e valores são devolvidos como **strings** decimais, para nenhum cliente perder precisão; a entrada aceita inteiros seguros ou strings. Erros seguem sempre `{"error":{"code","message","details?"}}`.

| Rota | Função |
| --- | --- |
| `POST /v1/meters`, `GET /v1/meters` | `sum`, `max` ou `unique` (valores distintos de uma propriedade do evento) |
| `POST /v1/plans`, `GET /v1/plans/:id` | moeda, taxa base, um preço por medidor: `graduated`, `volume`, `package` |
| `POST /v1/customers`, `GET /v1/customers/:id` | criar cliente enfileira a sincronização com o Stripe |
| `POST /v1/customers/:id/credits`, `GET .../credits` | concessão de créditos (chave de idempotência opcional) e o ledger |
| `POST /v1/subscriptions`, `POST .../:id/change-plan` | assinatura mensal; troca de plano enfileira um ajuste de rateio |
| `POST /v1/events` | lote de até 1000 eventos, com status por evento |
| `GET /v1/usage` | agregação em `[from, to)`, opcionalmente por `hour`/`day`/`month` (UTC) |
| `GET /v1/subscriptions/:id/invoice-preview` | a fatura como está agora, sem gravar nada |
| `POST /v1/subscriptions/:id/invoices` | fecha um período encerrado; com `period_start`, repetições devolvem a mesma fatura |
| `GET /v1/invoices/:id` | fatura com detalhamento por faixa |
| `POST /webhooks/stripe` | eventos do Stripe autenticados por assinatura |
| `GET /healthz`, `GET /readyz` | liveness, readiness (consulta o banco) |

Preço em um item do plano:

```json
{ "model": "graduated", "tiers": [
  { "up_to": 1000,  "unit_amount": "0" },
  { "up_to": 10000, "unit_amount": "0.5" },
  { "up_to": null,  "unit_amount": "0.2", "flat_amount": 0 } ] }
{ "model": "package", "package_size": 25, "package_amount": "1500" }
```

`unit_amount` é uma string decimal em unidades menores (centavos) com até 9 casas; `flat_amount` é em unidades menores inteiras.

## Decisões de projeto e trade-offs

**Preço exato, arredondando uma vez.** Preços são `bigint` multiplicados por 10^9. O total de uma linha é somado entre as faixas com precisão total e arredondado (meio para longe de zero) uma única vez. Uso zero custa zero em todo modelo; a taxa fixa de uma faixa vale quando o uso entra nela. O preço `volume` é propositalmente *não* monotônico na fronteira (101 unidades podem custar menos que 100); `graduated` e `package` são, e os testes de propriedade afirmam exatamente essa distinção.

**Idempotência é uma chave primária, não um cache.** `(tenant, idempotency_key)` é a chave primária de `events` e os lotes usam `INSERT ... ON CONFLICT DO NOTHING`. Cada evento guarda o hash do payload canônico: repetição vira `duplicate`; reutilizar a chave com outro corpo vira `conflict` (o original nunca é sobrescrito). As linhas de um lote são inseridas em ordem de chave, para que lotes concorrentes sobrepostos adquiram locks de índice na mesma ordem.

**Evento atrasado usa `effective_at`, não uma segunda fatura.** Ao fechar um período, o `usage_watermark` do cliente passa a ser o fim dele. Um evento anterior ao watermark é aceito, marcado como `late`, e seu `effective_at` é ajustado ao watermark para ser cobrado no período aberto. A fatura finalizada nunca é alterada. Eventos mais velhos que `MAX_EVENT_AGE_DAYS` (35) ou além de `MAX_CLOCK_SKEW_SECONDS` no futuro são rejeitados.

**Ingestão x fechamento é um lock, não um laço de retentativas.** A ingestão lê o watermark sob `FOR KEY SHARE` na linha do cliente; o fechamento toma `FOR UPDATE` nela primeiro. Os dois conflitam: o lote ou confirma antes da agregação (e entra na fatura) ou enxerga o novo watermark (e é adiado). Lotes de ingestão não bloqueiam uns aos outros.

**O fechamento é uma transação.** Trava cliente e assinatura, agrega, precifica, insere a fatura (única por assinatura e período), numera por contador do tenant, consome créditos, avança watermark e período e enfileira o envio ao Stripe. Fechamentos concorrentes do mesmo período geram uma fatura.

**O rateio corrige uma taxa cobrada em atraso.** A fatura cobra a taxa base do plano atual pelo período inteiro; uma troca no meio do período enfileira `(taxa_antiga - taxa_nova) x fração_decorrida`, e várias trocas se somam à taxa ponderada pelo tempo. As faixas de uso não são rateadas.

**Outbox, não escrita dupla.** O job do Stripe entra na mesma transação da fatura. Workers pegam linhas com `FOR UPDATE SKIP LOCKED` e prazo de lease (jobs de um worker que caiu voltam à fila), tentam de novo erros transitórios com backoff exponencial, enviam erros permanentes para dead-letter e sempre chamam o Stripe com uma chave de idempotência determinística derivada do id do agregado: "timeout após sucesso" reaproveita em vez de duplicar.

**Webhooks são verificados, deduplicados e ordenados pelo tempo do próprio evento.** O HMAC é calculado sobre o corpo bruto e comparado em tempo constante; várias entradas `v1` são aceitas (rotação de segredo); o timestamp precisa estar na janela de tolerância (padrão 300 s). O id do evento é reservado por um `INSERT` na mesma transação que o aplica, então duplicatas concorrentes são aplicadas uma vez. O estado segue o `created` do evento, nunca a ordem de chegada (empate: `paid` vence). Evento de uma fatura cujo id do Stripe ainda não foi vinculado fica retido como `orphaned` e é reaplicado, do mais antigo ao mais novo, quando o worker vincula; um advisory lock por fatura torna "vincular" e "aplicar" mutuamente exclusivos, então um evento retido nunca é perdido.

**Outras escolhas.** `Bun.SQL` em vez de ORM, para que o comportamento de locks e `ON CONFLICT` fique visível no código. O tempo vem de um `Clock` injetado, então os testes são determinísticos. As agregações são calculadas sobre a tabela de eventos na leitura (índice em cliente, medidor, `effective_at`) em vez de rollups mantidos: mais simples e sempre consistente, ao custo do tempo de varredura em períodos muito grandes.

## Testes

`bun test` executa 142 testes em 13 arquivos, incluindo propriedades com fast-check, contra um PostgreSQL real (a suíte cria e migra bancos `*_test` sozinha e recusa qualquer outro nome).

| Área | O que é provado |
| --- | --- |
| Propriedades de preço | graduated igual a uma referência unidade por unidade; não negativo e monotônico; cruzar a fronteira soma exatamente o preço da próxima faixa; exato para quantidades até 10^40; volume troca de faixa exatamente na fronteira; package é `ceil(q/tamanho)` |
| Rateio, períodos | aritmética de meses com clamp não deriva; trocas sucessivas de plano somam dentro de meia unidade menor cada |
| Ordem de eventos | qualquer ordem de entrega dos eventos do Stripe converge ao mesmo estado |
| Concorrência na ingestão | 40 lotes concorrentes sobrepostos ingerem cada chave exatamente uma vez; 12 payloads conflitantes concorrentes geram um vencedor |
| Ingestão x fechamento | 300 eventos concorrendo com um fechamento são conservados: na fatura ou adiados, nunca perdidos nem duplicados |
| Concorrência no fechamento | 8 fechamentos paralelos criam uma fatura, um consumo de crédito, um job no outbox |
| Outbox | tempos de retry/backoff, dead-letter, máximo de tentativas, timeout após sucesso reutiliza a chave de idempotência, 3 workers entregam 45 jobs exatamente uma vez, lease expirado é assumido |
| Webhooks | assinaturas ausentes/erradas/adulteradas/com outro timestamp, bordas da janela de replay, replay de requisição capturada, entrega duplicada concorrente, fora de ordem, órfão e depois vínculo, webhook concorrendo com o vínculo |
| HTTP | autenticação, isolamento entre tenants em todas as rotas, formato de validação, 413, 500 genérico, valores acima de 2^53 de ponta a ponta |

Cobertura de `bun test --coverage` na última execução completa: 99,4 % das linhas e 97,4 % das funções (todo `src/` mais o harness de teste). Nenhum benchmark de vazão foi executado, então nenhum é afirmado.

```bash
bun install
docker compose up -d db                                     # ou qualquer PostgreSQL 16
export TEST_DATABASE_URL=postgres://meterly:meterly-dev-only@127.0.0.1:5432/meterly_test
bun run typecheck && bun run lint && bun test
```

## Limitações

- O servidor distribuído usa o Stripe **fake em memória**. O estado do fake se perde ao reiniciar (os ids de fatura já gravados não). Um cliente real implementaria `StripeGateway`; nenhum está incluído.
- Períodos mensais, uma assinatura por cliente, sem cancelamento, trials, impostos ou descontos. A taxa base é cobrada em atraso.
- Eventos atrasados são cobrados no período aberto, não por fatura corretiva; acima da idade máxima são rejeitados.
- Créditos não expiram; um plano tem uma moeda e créditos são por moeda.
- Tenants são criados por CLI; não há rotação/revogação de chaves nem rate limiting.
- Os retries do outbox usam backoff exponencial determinístico, sem jitter; o worker faz polling em vez de `LISTEN/NOTIFY`.
- Sem teste de carga: a vazão de ingestão e o custo de agregação em períodos muito grandes não foram medidos.

## Licença

[MIT](LICENSE)

---

Built by [Chico Oliveira](https://github.com/FrancisWorld)
