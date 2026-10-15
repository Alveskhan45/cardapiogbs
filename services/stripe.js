// @ts-check
/* ============================================================
   Stripe Payment Provider
   Documentação: https://stripe.com/docs/api
   ============================================================ */
'use strict';

const Stripe = require('stripe');

/** @type {import('stripe').Stripe | null} */
let stripe = null;
const WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET || '';

/**
 * @typedef {Record<string, string>} StripeMetadata
 */

/**
 * @typedef {import('./payment-providers').PlanInput} PlanInput
 */

/**
 * @typedef {Object} PaymentIntentParams
 * @property {number} amount - valor em centavos
 * @property {string} [currency]
 * @property {string} [customerId]
 * @property {StripeMetadata} [metadata]
 */

/**
 * @typedef {Object} PriceParams
 * @property {string} productName
 * @property {number} amount - valor em centavos
 * @property {string} [currency]
 * @property {string} [interval]
 * @property {StripeMetadata} [metadata]
 */

function getStripe() {
  if (!stripe) {
    const key = process.env.STRIPE_SECRET_KEY;
    if (!key) throw new Error('STRIPE_SECRET_KEY não configurado');
    // Sem fixar apiVersion: o SDK aplica a versão com que foi gerado,
    // mantendo runtime e tipos em sincronia.
    stripe = new Stripe(key);
  }
  return stripe;
}

/**
 * Cria cliente no Stripe.
 * @param {{ email: string, name?: string, metadata?: StripeMetadata }} data
 * @returns {Promise<{ customerId: string, email: string }>}
 */
async function createCustomer({ email, name, metadata = {} }) {
  const customer = await getStripe().customers.create({
    email,
    name,
    metadata: { source: 'cardapio-saas', ...metadata }
  });
  return { customerId: customer.id, email: customer.email ?? '' };
}

/**
 * Anexa payment method ao cliente.
 * @param {string} customerId
 * @param {string} paymentMethodId
 */
async function attachPaymentMethod(customerId, paymentMethodId) {
  await getStripe().paymentMethods.attach(paymentMethodId, { customer: customerId });
}

/**
 * Extrai o client_secret do PaymentIntento ligado à primeira invoice.
 *
 * O caminho mudou entre versões da API: o legado era `invoice.payment_intent`
 * e, a partir de 2025, é `invoice.payments.data[].payment_intent`. Os tipos do
 * SDK não descrevem `payment_intent` no nível da invoice, então o acesso passa
 * por `unknown` e o código tenta os dois formatos.
 *
 * @param {import('stripe').Subscription} subscription
 * @returns {string|undefined}
 */
function extractClientSecret(subscription) {
  const invoice = subscription.latest_invoice;
  if (!invoice || typeof invoice !== 'object') return undefined;

  const modern = /** @type {{ payments?: { data?: Array<{ payment_intent?: string | { client_secret?: string | null } }> } }} */ (
    /** @type {unknown} */ (invoice)
  );
  const modernRef = modern.payments?.data?.[0]?.payment_intent;
  if (modernRef && typeof modernRef === 'object' && modernRef.client_secret) {
    return modernRef.client_secret;
  }

  const legacy = /** @type {{ payment_intent?: { client_secret?: string | null } }} */ (
    /** @type {unknown} */ (invoice)
  );
  return legacy.payment_intent?.client_secret ?? undefined;
}

/**
 * Cria assinatura no Stripe.
 *
 * O plano chega resolvido e em reais; o Stripe cobra em centavos, então a
 * conversão e a criação/reuso do price acontecem aqui (Stripe não tem o
 * conceito de "cobrança de valor X a cada mês" fora de um price).
 *
 * @param {string} customerId
 * @param {PlanInput} plan
 * @param {StripeMetadata} metadata
 * @returns {Promise<{ subscriptionId: string, status: string, currentPeriodEnd: Date, clientSecret?: string }>}
 */
async function createSubscription(customerId, plan, metadata = {}) {
  const { priceId } = await createPrice({
    productName: `Plano ${plan.name}`,
    amount: Math.round(plan.priceMonthly * 100),
    currency: 'brl',
    interval: 'month',
    metadata: { planId: plan.id }
  });

  const subscription = await getStripe().subscriptions.create({
    customer: customerId,
    items: [{ price: priceId }],
    payment_behavior: 'default_incomplete',
    payment_settings: { save_default_payment_method: 'on_subscription' },
    expand: ['latest_invoice.payments.data.payment_intent'],
    metadata: { source: 'cardapio-saas', ...metadata }
  });

  // A partir da API 2025-03-31 o período vive no item, não na assinatura.
  const item = subscription.items.data[0];
  const currentPeriodEnd = new Date(item.current_period_end * 1000);

  return {
    subscriptionId: subscription.id,
    status: subscription.status,
    currentPeriodEnd,
    clientSecret: extractClientSecret(subscription)
  };
}

/**
 * Cancela assinatura no Stripe.
 * @param {string} subscriptionId
 */
async function cancelSubscription(subscriptionId) {
  await getStripe().subscriptions.cancel(subscriptionId);
}

/**
 * Cria sessão do portal do cliente.
 * @param {string} customerId
 * @param {string} returnUrl
 * @returns {Promise<{ url: string }>}
 */
async function createPortalSession(customerId, returnUrl) {
  const session = await getStripe().billingPortal.sessions.create({
    customer: customerId,
    return_url: returnUrl
  });
  return { url: session.url };
}

/**
 * Verifica assinatura do webhook.
 * @param {string|Object} payload
 * @param {string} signature
 * @returns {boolean}
 */
function verifyWebhookSignature(payload, signature) {
  try {
    getStripe().webhooks.constructEvent(
      typeof payload === 'string' ? payload : JSON.stringify(payload),
      signature,
      WEBHOOK_SECRET
    );
    return true;
  } catch {
    return false;
  }
}

/**
 * Processa webhook do Stripe.
 * @param {string|Object} payload
 * @param {string} signature
 * @returns {Promise<{ type: string, data: Object, idempotencyKey: string }>}
 */
async function handleWebhook(payload, signature) {
  if (!verifyWebhookSignature(payload, signature)) {
    throw new Error('Assinatura do webhook Stripe inválida');
  }
  const event = getStripe().webhooks.constructEvent(
    typeof payload === 'string' ? payload : JSON.stringify(payload),
    signature,
    WEBHOOK_SECRET
  );
  // Chave de idempotência: event.id (único por evento)
  return {
    type: event.type,
    data: event.data.object,
    idempotencyKey: `stripe_${event.id}`
  };
}

/**
 * Cria PaymentIntent para checkout direto.
 * @param {PaymentIntentParams} params
 * @returns {Promise<{ clientSecret: string, paymentIntentId: string }>}
 */
async function createPaymentIntent({ amount, currency = 'brl', customerId, metadata = {} }) {
  const pi = await getStripe().paymentIntents.create({
    amount: Math.round(amount),
    currency,
    customer: customerId,
    automatic_payment_methods: { enabled: true },
    metadata: { source: 'cardapio-saas', ...metadata }
  });
  if (!pi.client_secret) throw new Error('Stripe não retornou client_secret para o PaymentIntent');
  return { clientSecret: pi.client_secret, paymentIntentId: pi.id };
}

/**
 * Cria Price no Stripe (para plano).
 * @param {PriceParams} params
 * @returns {Promise<{ priceId: string }>}
 */
async function createPrice({ productName, amount, currency = 'brl', interval = 'month', metadata = {} }) {
  // Reaproveita o produto pelo metadata; `list` não filtra por metadata, então usa `search`.
  const found = await getStripe().products.search({
    query: `metadata['source']:'cardapio-saas' AND metadata['productName']:'${productName.replace(/'/g, "\\'")}'`
  });
  let product = found.data[0];
  if (!product) {
    product = await getStripe().products.create({
      name: productName,
      metadata: { source: 'cardapio-saas', productName }
    });
  }
  const price = await getStripe().prices.create({
    product: product.id,
    unit_amount: Math.round(amount),
    currency,
    recurring: { interval },
    metadata: { source: 'cardapio-saas', ...metadata }
  });
  return { priceId: price.id };
}

module.exports = {
  name: 'stripe',
  createCustomer,
  attachPaymentMethod,
  createSubscription,
  cancelSubscription,
  createPortalSession,
  createPaymentIntent,
  createPrice,
  handleWebhook,
  verifyWebhookSignature
};