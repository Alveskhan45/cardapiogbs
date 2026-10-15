// @ts-check
/* ============================================================
   Asaas Payment Provider (Pix / Boleto / Cartão - Brasil)
   Documentação: https://docs.asaas.com/
   ============================================================ */
'use strict';

const crypto = require('crypto');

const ASAAS_BASE = process.env.ASAAS_BASE_URL || 'https://api.asaas.com/v3';
const ASAAS_TOKEN = process.env.ASAAS_API_KEY || '';
const WEBHOOK_SECRET = process.env.ASAAS_WEBHOOK_SECRET || '';

/**
 * @typedef {Object} FetchOptions
 * @property {string} [method]
 * @property {string} [body]
 * @property {Record<string, string>} [headers]
 */

/**
 * @typedef {Object} AsaasCustomerInput
 * @property {string} email
 * @property {string} [name]
 * @property {string} [phone]
 * @property {string} [cpfCnpj]
 * @property {Record<string, string>} [metadata]
 */

/**
 * @typedef {Object} PixChargeParams
 * @property {string} customerId
 * @property {number} value
 * @property {string} [dueDate]
 * @property {string} [description]
 * @property {Record<string, string>} [metadata]
 */

/**
 * @typedef {Object} PaymentLinkParams
 * @property {string} customerId
 * @property {number} value
 * @property {string} [description]
 * @property {string} [dueDate]
 * @property {Record<string, string>} [metadata]
 */

/**
 * @param {string} endpoint
 * @param {FetchOptions} [options]
 * @returns {Promise<any>}
 */
function asaasFetch(endpoint, options = {}) {
  if (!ASAAS_TOKEN) throw new Error('ASAAS_API_KEY não configurado');
  return fetch(`${ASAAS_BASE}${endpoint}`, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      'access_token': ASAAS_TOKEN,
      ...(options.headers || {})
    }
  }).then(async r => {
    if (!r.ok) {
      const text = await r.text();
      throw new Error(`Asaas ${r.status}: ${text}`);
    }
    return r.json();
  });
}

/**
 * Cria cliente no Asaas.
 * @param {AsaasCustomerInput} data
 * @returns {Promise<{ customerId: string, email: string }>}
 */
async function createCustomer({ email, name, phone, cpfCnpj, metadata = {} }) {
  const body = {
    name,
    email,
    phone,
    cpfCnpj,
    metadata: { source: 'cardapio-saas', ...metadata }
  };
  const customer = await asaasFetch('/customers', {
    method: 'POST',
    body: JSON.stringify(body)
  });
  return { customerId: customer.id, email: customer.email };
}

/**
 * Cria cobrança Pix (cobrança instantânea).
 * @param {PixChargeParams} params
 * @returns {Promise<{ paymentId: string, pixQrCode: string, pixCopyPaste: string, dueDate: string }>}
 */
async function createPixCharge({ customerId, value, dueDate, description, metadata = {} }) {
  const body = {
    customer: customerId,
    value,
    dueDate: dueDate || new Date().toISOString().split('T')[0],
    description,
    billingType: 'PIX',
    metadata: { source: 'cardapio-saas', ...metadata }
  };
  const charge = await asaasFetch('/payments', {
    method: 'POST',
    body: JSON.stringify(body)
  });
  return {
    paymentId: charge.id,
    pixQrCode: charge.pixQrCode,
    pixCopyPaste: charge.pixCopyPaste,
    dueDate: charge.dueDate
  };
}

/**
 * Cria assinatura recorrente no Asaas.
 *
 * O Asaas não tem "price": cobra um `value` em reais com um `cycle`. O
 * adaptador traduz o mesmo plano que o Stripe recebe, para os dois
 * provedores obedecerem ao mesmo contrato.
 *
 * @param {string} customerId
 * @param {import('./payment-providers').PlanInput} plan
 * @param {Record<string, string>} metadata
 * @returns {Promise<{ subscriptionId: string, status: string, currentPeriodEnd: Date, clientSecret?: string }>}
 */
async function createSubscription(customerId, plan, metadata = {}) {
  const body = {
    customer: customerId,
    value: plan.priceMonthly,
    cycle: 'MONTHLY',
    description: `Plano ${plan.name}`,
    nextDueDate: new Date().toISOString().split('T')[0],
    billingType: 'PIX',
    metadata: { source: 'cardapio-saas', planId: plan.id, ...metadata }
  };
  const sub = await asaasFetch('/subscriptions', {
    method: 'POST',
    body: JSON.stringify(body)
  });

  // O Asaas devolve nextDueDate como 'YYYY-MM-DD'; o contrato comum pede Date.
  const currentPeriodEnd = new Date(`${sub.nextDueDate}T12:00:00Z`);

  return {
    subscriptionId: sub.id,
    status: sub.status,
    currentPeriodEnd,
    clientSecret: undefined
  };
}

/**
 * Cancela assinatura no Asaas.
 * @param {string} subscriptionId
 */
async function cancelSubscription(subscriptionId) {
  await asaasFetch(`/subscriptions/${subscriptionId}`, { method: 'DELETE' });
}

/**
 * Cria link de pagamento (checkout Asaas).
 * @param {PaymentLinkParams} params
 * @returns {Promise<{ paymentUrl: string, paymentId: string }>}
 */
async function createPaymentLink({ customerId, value, description, dueDate, metadata = {} }) {
  const body = {
    customer: customerId,
    value,
    description,
    dueDate: dueDate || new Date().toISOString().split('T')[0],
    billingType: 'PIX',
    metadata: { source: 'cardapio-saas', ...metadata }
  };
  const charge = await asaasFetch('/payments', {
    method: 'POST',
    body: JSON.stringify(body)
  });
  return { paymentUrl: charge.invoiceUrl, paymentId: charge.id };
}

/**
 * Verifica assinatura do webhook Asaas.
 * @param {string|Object} payload
 * @param {string} signature
 * @returns {boolean}
 */
function verifyWebhookSignature(payload, signature) {
  if (!WEBHOOK_SECRET) return true; // Sem secret configurado, aceita (dev)
  const expected = crypto
    .createHmac('sha256', WEBHOOK_SECRET)
    .update(typeof payload === 'string' ? payload : JSON.stringify(payload))
    .digest('hex');
  const received = Buffer.from(String(signature));
  const expectedBuf = Buffer.from(expected);
  // timingSafeEqual exige mesmo tamanho de buffer; comparar antes evita lançar.
  if (received.length !== expectedBuf.length) return false;
  return crypto.timingSafeEqual(received, expectedBuf);
}

/**
 * Processa webhook do Asaas.
 * @param {string|Object} payload
 * @param {string} signature
 * @returns {Promise<{ type: string, data: Object, idempotencyKey: string }>}
 */
async function handleWebhook(payload, signature) {
  if (!verifyWebhookSignature(payload, signature)) {
    throw new Error('Assinatura do webhook Asaas inválida');
  }
  const event = typeof payload === 'string' ? JSON.parse(payload) : payload;
  // Eventos Asaas: PAYMENT_RECEIVED, PAYMENT_OVERDUE, SUBSCRIPTION_CREATED, etc.
  // Chave de idempotência: id do recurso + tipo do evento, com prefixo do provedor
  // (mesmo formato do Stripe, para não colidir na tabela webhook_events).
  const resourceId = event.id || event.payment?.id || event.subscription?.id;
  return {
    type: event.event,
    data: event.payment || event.subscription || event,
    idempotencyKey: `asaas_${resourceId}_${event.event}`
  };
}

module.exports = {
  name: 'asaas',
  createCustomer,
  createSubscription,
  cancelSubscription,
  createPixCharge,
  createPaymentLink,
  handleWebhook,
  verifyWebhookSignature
};