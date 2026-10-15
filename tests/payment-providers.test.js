/* Testes dos adaptadores de pagamento com a rede mockada.
 *
 * Foco: o corpo que realmente sai para o provedor. Foi aqui que moraram os
 * bugs mais caros desta parte do sistema — plano lido com o nome do campo
 * errado (virava NaN) e reais/centavos trocados entre Stripe e Asaas. O
 * TypeScript não pegava nenhum dos dois porque validava contra os nossos
 * próprios typedefs, então o que protege é o corpo da requisição.
 *
 * Nada aqui toca a rede: o Asaas usa `fetch` global e o Stripe recebe um
 * httpClient dublê pelo contrato oficial do SDK (`HttpClient`).
 */
process.env.STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY || 'sk_test_mock';
process.env.ASAAS_API_KEY = process.env.ASAAS_API_KEY || '$mock-key';
// O segredo é lido no load do módulo, então precisa existir antes do require.
process.env.ASAAS_WEBHOOK_SECRET = process.env.ASAAS_WEBHOOK_SECRET || 'segredo-de-teste';

const stripe = require('../services/stripe');
const asaas = require('../services/asaas');

/** Plano de exemplo: 29,90 reais. */
const PLANO_STARTER = { id: 'starter', name: 'Starter', priceMonthly: 29.9 };
const PLANO_PRO = { id: 'pro', name: 'Pro', priceMonthly: 79.9 };

/* ------------------------------------------------------------------ */
/* Doublês                                                              */
/* ------------------------------------------------------------------ */

/**
 * O SDK do Stripe envia `application/x-www-form-urlencoded`, não JSON, e
 * achata os objetos em notação de colchete (`recurring[interval]=month`).
 * Parsear como JSON estoura o makeRequest e o SDK reporta
 * "Unable to authenticate the request", então o mock precisa desempacotar.
 * @param {string|null} raw
 * @returns {any}
 */
function parseStripeBody(raw) {
  if (!raw) return null;
  const s = String(raw).trim();
  if (s.startsWith('{') || s.startsWith('[')) return JSON.parse(s);

  /** @type {Record<string, any>} */
  const out = {};
  for (const [chave, valor] of new URLSearchParams(s)) {
    const m = chave.match(/^([^[]+)\[([^[]+)\]$/);
    if (m) {
      out[m[1]] = out[m[1]] || {};
      out[m[1]][m[2]] = valor;
    } else {
      out[chave] = valor;
    }
  }
  return out;
}

/**
 * Cliente HTTP do Stripe. `respostas` é uma fila: cada request consome uma,
 * na ordem em que o adaptador dispara as chamadas.
 *
 * O SDK exige o retorno como Promise (`req.then(...)` em RequestSender) e usa
 * `request-id` no header para validar que a resposta veio do Stripe — sem ele
 * o SDK lança "Unable to authenticate the request".
 */
function stripeClient(respostas) {
  const calls = [];
  return {
    calls,
    getClientName: () => 'fake-stripe',
    makeRequest(host, port, path, method, headers, requestData) {
      calls.push({ path, method, body: parseStripeBody(requestData) });
      const r = respostas.shift() || {};
      return Promise.resolve({
        getStatusCode: () => r.statusCode || 200,
        getHeaders: () => ({ 'request-id': 'req_mock' }),
        getRawResponse: () => ({}),
        toStream: () => {},
        toJSON: async () => r.body || {}
      });
    }
  };
}

/** Encontra a primeira chamada cujo path contém `trecho`. */
function callTo(cliente, trecho) {
  return cliente.calls.find(c => c.path.includes(trecho));
}

/** Resposta de assinatura do Stripe com a forma que o SDK v23 devolve. */
function subscriptionResponse(overrides = {}) {
  return {
    id: 'sub_mock',
    status: 'incomplete',
    latest_invoice: {
      payments: { data: [{ payment_intent: { id: 'pi_mock', client_secret: 'pi_mock_secret' } }] }
    },
    items: { data: [{ id: 'si_mock', current_period_end: 1800000000 }] },
    ...overrides
  };
}

/** Doblé de `fetch` para o Asaas. `respostas` é uma fila de corpos. */
function asaasFetchMock(respostas) {
  const calls = [];
  global.fetch = jest.fn(async (url, options) => {
    calls.push({ url, method: options.method, body: options.body ? JSON.parse(options.body) : null });
    const body = respostas.shift() || {};
    return {
      ok: true,
      status: 200,
      json: async () => body,
      text: async () => JSON.stringify(body)
    };
  });
  return calls;
}

beforeEach(() => {
  stripe.setHttpClient(null);
});

afterEach(() => {
  stripe.setHttpClient(null);
  delete global.fetch;
});

/* ------------------------------------------------------------------ */
/* Stripe — precifica em CENTAVOS                                      */
/* ------------------------------------------------------------------ */

describe('Stripe: createSubscription', () => {
  test('converte o preço do plano de reais para centavos', async () => {
    const client = stripeClient([
      { body: { data: [] } },                  // products.search: não achou
      { body: { id: 'prod_mock', name: 'Plano Starter' } },
      { body: { id: 'price_mock' } },          // prices.create
      { body: subscriptionResponse() }
    ]);
    stripe.setHttpClient(client);

    await stripe.createSubscription('cus_mock', PLANO_STARTER, { tenantId: 't1' });

    // 29,90 reais -> 2990 centavos. Se virar 29.90 o Stripe cobra R$ 0,03.
    const price = callTo(client, '/prices');
    expect(Number(price.body.unit_amount)).toBe(2990);
    expect(price.body.recurring.interval).toBe('month');
    expect(price.body.currency).toBe('brl');
  });

  test('arredonda centavos para planos com valor fracionário', async () => {
    const client = stripeClient([
      { body: { data: [] } },
      { body: { id: 'prod_mock' } },
      { body: { id: 'price_mock' } },
      { body: subscriptionResponse() }
    ]);
    stripe.setHttpClient(client);

    await stripe.createSubscription('cus_mock', PLANO_PRO, {});

    expect(Number(callTo(client, '/prices').body.unit_amount)).toBe(7990);
  });

  test('reaproveita o produto quando a busca por metadata acha um', async () => {
    const client = stripeClient([
      { body: { data: [{ id: 'prod_existente' }] } },  // search achou
      { body: { id: 'price_mock' } },
      { body: subscriptionResponse() }
    ]);
    stripe.setHttpClient(client);

    await stripe.createSubscription('cus_mock', PLANO_STARTER, {});

    // Não deve criar produto novo quando o search devolveu um.
    // (search é GET em /v1/products/search; a criação é POST em /v1/products)
    expect(client.calls.some(c => c.method === 'POST' && c.path === '/v1/products')).toBe(false);
    expect(callTo(client, '/products/search')).toBeTruthy();
    expect(callTo(client, '/prices').body.product).toBe('prod_existente');
  });

  test('lê o vencimento de items.data[0] (migrado no SDK v23)', async () => {
    const client = stripeClient([
      { body: { data: [] } },
      { body: { id: 'prod_mock' } },
      { body: { id: 'price_mock' } },
      { body: subscriptionResponse() }
    ]);
    stripe.setHttpClient(client);

    const r = await stripe.createSubscription('cus_mock', PLANO_STARTER, {});

    // current_period_end saiu de Subscription e foi para SubscriptionItem.
    expect(r.currentPeriodEnd).toBeInstanceOf(Date);
    expect(r.currentPeriodEnd.getTime()).toBe(1800000000 * 1000);
  });

  test('extrai o client_secret do caminho novo (invoice.payments)', async () => {
    const client = stripeClient([
      { body: { data: [] } },
      { body: { id: 'prod_mock' } },
      { body: { id: 'price_mock' } },
      { body: subscriptionResponse() }
    ]);
    stripe.setHttpClient(client);

    const r = await stripe.createSubscription('cus_mock', PLANO_STARTER, {});

    expect(r.clientSecret).toBe('pi_mock_secret');
  });

  test('cai no formato legado quando payments não vem preenchido', async () => {
    const client = stripeClient([
      { body: { data: [] } },
      { body: { id: 'prod_mock' } },
      { body: { id: 'price_mock' } },
      {
        body: {
          id: 'sub_mock',
          status: 'incomplete',
          latest_invoice: { payment_intent: { client_secret: 'segredo_legado' } },
          items: { data: [{ current_period_end: 1800000000 }] }
        }
      }
    ]);
    stripe.setHttpClient(client);

    const r = await stripe.createSubscription('cus_mock', PLANO_STARTER, {});

    expect(r.clientSecret).toBe('segredo_legado');
  });

  test('não explode quando não há client_secret', async () => {
    const client = stripeClient([
      { body: { data: [] } },
      { body: { id: 'prod_mock' } },
      { body: { id: 'price_mock' } },
      { body: subscriptionResponse({ latest_invoice: null }) }
    ]);
    stripe.setHttpClient(client);

    const r = await stripe.createSubscription('cus_mock', PLANO_STARTER, {});

    expect(r.clientSecret).toBeUndefined();
    expect(r.subscriptionId).toBe('sub_mock');
  });

  test('propaga tenantId e plan nos metadata', async () => {
    const client = stripeClient([
      { body: { data: [] } },
      { body: { id: 'prod_mock' } },
      { body: { id: 'price_mock' } },
      { body: subscriptionResponse() }
    ]);
    stripe.setHttpClient(client);

    await stripe.createSubscription('cus_mock', PLANO_STARTER, { tenantId: 't1', plan: 'starter' });

    const sub = callTo(client, '/subscriptions');
    expect(sub.body.metadata).toMatchObject({ source: 'cardapio-saas', tenantId: 't1', plan: 'starter' });
    expect(sub.body.customer).toBe('cus_mock');
  });
});

/* ------------------------------------------------------------------ */
/* Asaas — cobra em REAIS                                              */
/* ------------------------------------------------------------------ */

describe('Asaas: createSubscription', () => {
  test('manda o valor em reais, não em centavos', async () => {
    const calls = asaasFetchMock([
      { id: 'sub_mock', status: 'ACTIVE', nextDueDate: '2026-03-10' }
    ]);

    await asaas.createSubscription('cus_mock', PLANO_STARTER, { tenantId: 't1' });

    expect(calls[0].url).toBe('https://api.asaas.com/v3/subscriptions');
    // 29,90 reais. Se mandar 2990 o Asaas cobra R$ 2.990,00.
    expect(calls[0].body.value).toBe(29.9);
    expect(calls[0].body.customer).toBe('cus_mock');
    expect(calls[0].body.cycle).toBe('MONTHLY');
    expect(calls[0].billingType).toBeUndefined();
    expect(calls[0].body.billingType).toBe('PIX');
  });

  test('normaliza nextDueDate para Date', async () => {
    asaasFetchMock([{ id: 'sub_mock', status: 'ACTIVE', nextDueDate: '2026-03-10' }]);

    const r = await asaas.createSubscription('cus_mock', PLANO_STARTER, {});

    expect(r.currentPeriodEnd).toBeInstanceOf(Date);
    expect(r.currentPeriodEnd.toISOString().slice(0, 10)).toBe('2026-03-10');
    expect(r.subscriptionId).toBe('sub_mock');
  });

  test('respeita o mesmo contrato de retorno do Stripe', async () => {
    asaasFetchMock([{ id: 'sub_mock', status: 'ACTIVE', nextDueDate: '2026-03-10' }]);

    const r = await asaas.createSubscription('cus_mock', PLANO_PRO, {});

    // É isso que o payment.js consome: o contrato tem que ser o mesmo.
    expect(Object.keys(r).sort()).toEqual(['clientSecret', 'currentPeriodEnd', 'status', 'subscriptionId']);
  });

  test('leva planId e tenantId nos metadata', async () => {
    const calls = asaasFetchMock([
      { id: 'sub_mock', status: 'ACTIVE', nextDueDate: '2026-03-10' }
    ]);

    await asaas.createSubscription('cus_mock', PLANO_STARTER, { tenantId: 't1' });

    expect(calls[0].body.metadata).toMatchObject({
      source: 'cardapio-saas',
      planId: 'starter',
      tenantId: 't1'
    });
  });
});

/* ------------------------------------------------------------------ */
/* Idempotência e assinatura                                            */
/* ------------------------------------------------------------------ */

describe('Asaas: webhook', () => {
  /** HMAC no mesmo formato que verifyWebhookSignature espera. */
  function assinar(payload) {
    const crypto = require('crypto');
    return crypto
      .createHmac('sha256', process.env.ASAAS_WEBHOOK_SECRET)
      .update(payload)
      .digest('hex');
  }

  test('a chave de idempotência tem o prefixo uma vez só', async () => {
    const body = JSON.stringify({ id: 'pay_1', event: 'PAYMENT_RECEIVED', payment: { id: 'pay_1' } });
    const r = await asaas.handleWebhook(body, assinar(body));

    // O bug antigo gerava "asaas_asaas_pay_1_PAYMENT_RECEIVED".
    expect(r.idempotencyKey).toBe('asaas_pay_1_PAYMENT_RECEIVED');
    expect(r.idempotencyKey.match(/asaas_/g)).toHaveLength(1);
  });

  test('usa o id do recurso quando o evento não tem id', async () => {
    const body = JSON.stringify({ event: 'SUBSCRIPTION_CREATED', subscription: { id: 'sub_9' } });
    const r = await asaas.handleWebhook(body, assinar(body));

    expect(r.idempotencyKey).toBe('asaas_sub_9_SUBSCRIPTION_CREATED');
  });

  test('recusa assinatura inválida sem lançar', async () => {
    const body = JSON.stringify({ id: 'pay_1', event: 'PAYMENT_RECEIVED' });
    await expect(asaas.handleWebhook(body, 'a'.repeat(64))).rejects.toThrow(
      'Assinatura do webhook Asaas inválida'
    );
  });

  test('assinatura de tamanho diferente retorna false em vez de lançar', () => {
    // crypto.timingSafeEqual lança se os buffers tiverem tamanhos distintos.
    expect(() => asaas.verifyWebhookSignature('{}', 'curta')).not.toThrow();
    expect(asaas.verifyWebhookSignature('{}', 'curta')).toBe(false);
  });

  test('assinatura válida é aceita e a adulterada recusada', () => {
    const body = JSON.stringify({ id: 'pay_1', event: 'PAYMENT_RECEIVED' });

    expect(asaas.verifyWebhookSignature(body, assinar(body))).toBe(true);
    expect(asaas.verifyWebhookSignature(body, 'a'.repeat(64))).toBe(false);
  });
});

describe('Stripe: webhook', () => {
  test('assinatura inválida é recusada sem lançar', () => {
    expect(stripe.verifyWebhookSignature('{"id":"evt_1"}', 't=1,v1=invalida')).toBe(false);
  });

  test('handleWebhook recusa payload sem assinatura válida', async () => {
    await expect(
      stripe.handleWebhook(JSON.stringify({ id: 'evt_1' }), 't=1,v1=invalida')
    ).rejects.toThrow('Assinatura do webhook Stripe inválida');
  });
});