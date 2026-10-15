# Handoff — pagamentos (Stripe/Asaas)

> **Arquivo temporário.** Registra o estado de um trabalho em andamento, para
> retomar em outro dia. Apagar assim que as pendências do fim do documento
> estiverem fechadas — envelhece e passa a mentir.
>
> Estado da branch `master` no momento em que o trabalho foi pausado.
> Commits **locais**, nada enviado ao remoto ainda.

## Onde paramos

```
6dabf89  Testes dos adaptadores de pagamento com a rede mockada
21014b9  Ferramentas de qualidade, backup/restore e pagamentos (Stripe/Asaas)
41099a9  (commit original do repositório)
```

Árvore de trabalho limpa, sem stash pendente.

### Gates

| Gate | Resultado |
| --- | --- |
| `npm run lint` | 0 erros (175 warnings do `eslint-plugin-security`, pré-existentes) |
| `npm run typecheck` | 0 erros (eram 115) |
| `npm run test:ci` | 130 testes, 8 suítes |
| `npm run test:isolation` | 112 checagens |
| `node --check` (todos os .js) | ok |

Tudo verde localmente com Postgres real (`npm run migrate` antes da suíte).

## Bugs corrigidos nesta rodada

Nenhum deles tinha cobertura de teste; a suíte passava com todos eles presentes.

**Pagamentos**

- **Webhooks nunca funcionavam.** `tenantResolver` roda em todo `/api/*` e
  `/api/webhooks/*` não estava em `isTenantlessRoute`, então todo webhook
  recebia `400 TENANT_REQUIRED` e nenhum pagamento era processado.
- **Webhook travava a requisição.** O `express.json()` global consumia o
  corpo antes do `rawBodyParser` escutar o stream; `'end'` nunca disparava e
  `next()` não era chamado. Agora o corpo cru vem do `verify` do
  `express.json`, que é o que a verificação de assinatura exige.
- **`await` faltando.** `getOrCreatePriceId` chamava `listPlans()` (async) e
  aplicava `.find()` sobre a Promise.
- **Preço virava `NaN`.** O plano era lido como `plan.price_monthly`, mas
  `billing.listPlans()` devolve `priceMonthly`.
- **Contrato do Asaas incompatível.** `createSubscription` recebia
  argumentos posicionais no `payment.js`, enquanto o Asaas esperava um objeto
  único — e o Asaas não tem `createPrice`, então o fluxo nem chegava na
  chamada. Agora o contrato comum recebe o **plano já resolvido**
  (`PlanInput`) e cada adaptador precifica do seu jeito: Stripe converte reais
  para centavos e cria/reusa o price; Asaas cobra `value` em reais.
- **Chave de idempotência duplicada no Asaas:** saía `asaas_asaas_...`.
- **`timingSafeEqual` sem comparar tamanhos:** assinatura de tamanho
  diferente lançava em vez de retornar `false`.

**Stripe (SDK v23 / API `2026-09-30.endive`)**

- `apiVersion` estava fixado em `2024-04-10`, dois anos defasado e em
  desacordo com os tipos do SDK. Removido o pin para o SDK usar a própria
  versão.
- `current_period_end` migrou de `Subscription` para `SubscriptionItem`; a
  leitura antiga devolvia `undefined` e gerava `Invalid Date`.
- `latest_invoice.payment_intent` virou
  `latest_invoice.payments.data[].payment_intent`. O helper
  `extractClientSecret` tenta os dois formatos.
- `products.list()` não aceita `metadata` como filtro, então a busca de
  produto devolvia sempre o primeiro. Trocada por `products.search()`.

**Tipos**

- 115 erros de `tsc` zerados por JSDoc preciso (`@typedef` + `@property`),
  sem `@ts-ignore`. Instalado `@types/express`.
- Removidos imports não usados e código morto (`createPixPayment`, que era
  alias de `createPixCharge` e nem estava exportado).

## Decisões de arquitetura

- **Corpo cru de webhook:** `express.json({ verify })` em `server.js`, em vez
  de ler o stream de novo dentro da rota.
- **Contrato de assinatura:** `createSubscription(customerId, plan, metadata)`
  recebe o plano resolvido, não um `priceId`. Cada PSP precifica do seu jeito.
- **Contrato do provedor:** superfície comum obrigatória + extras opcionais
  (`createPortalSession`, `createPaymentIntent`, `createPrice`), porque nem
  todo PSP suporta todos. Os consumidores checam antes de usar.
- **Costura de teste:** `stripe.setHttpClient()` usa o contrato oficial de
  `httpClient` do SDK. O `asaas.js` usa `fetch` global, que o Jest mocka
  direto.

## Pendências

### 1. Não dar push ainda

O `tsconfig.json` usa `module: NodeNext` com `moduleResolution: NodeNext`.
Tudo foi validado no Windows; o CI roda em `ubuntu-latest` com Node 22. Vale
rodar `npm ci && npm run typecheck` no Linux antes do push, porque resolução
de módulo pode divergir.

### 2. Smoke test do Stripe em modo teste

Os 19 testes de `tests/payment-providers.test.js` provam o **corpo enviado** e
o **parsing da resposta**, não que a API aceita. Rodar uma vez com
`STRIPE_SECRET_KEY` de teste e conferir:

- `expand: ['latest_invoice.payments.data.payment_intent']` é aceito
- `products.search` com a query de metadata funciona
- `current_period_end` vem preenchido em `items.data[0]`

Se algum divergir, o `clientSecret` volta `undefined` e o checkout do Stripe
não consegue confirmar o pagamento.

### 3. `services/payment-providers.js` é uma reconstrução

O arquivo original foi sobrescrito sem que as 115 linhas fossem lidas
inteiras, e **não há como recuperá-lo**: o repositório só teve 3 commits, sem
objetos soltos, stash, reflog antigo ou outra branch — o arquivo nunca entrou
no git antes. A implementação atual foi escrita do zero e é usada por
`services/payment.js`, mas convém procurar o original no histórico local do
VS Code/Cursor, em outra máquina ou num backup, e comparar.

### 4. `createSubscription` do Asaas não foi testado contra a API real

Os testes provam o corpo JSON enviado e a normalização do retorno. O
`createSubscription` foi reescrito do zero e não tem validação de resposta.

### 5. Procurar outros usos de `price_monthly`

O bug do `NaN` foi corrigido em `services/payment.js`. Vale grepar o resto do
código por esse nome de campo, já que `billing.listPlans()` devolve
`priceMonthly`.

## Como verificar

```bash
npm ci
npm run migrate          # precisa de Postgres no DATABASE_URL
npm run lint
npm run typecheck
npm run test:ci
npm run test:isolation
```

Testes dos provedores sozinhos, sem banco:

```bash
npx jest tests/payment-providers.test.js --runInBand
```

## Nota para quem mexer nos testes de webhooks

O SDK do Stripe envia `application/x-www-form-urlencoded`, **não JSON**, e
achata objetos em notação de colchete (`recurring[interval]=month`,
`metadata[tenantId]=t1`). Um `JSON.parse` no mock estoura dentro do
`makeRequest` e o SDK reporta o erro enganoso `Unable to authenticate the
request`. Além disso, `makeRequest` precisa retornar uma **Promise** e a
resposta precisa trazer o header `request-id`.