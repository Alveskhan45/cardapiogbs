// @ts-check
/* ============================================================
   Abstração de provedores de pagamento (Stripe, Asaas, etc.)

   Interface mínima que cada provedor deve implementar:
   - createCustomer(data)
   - createPaymentMethod(customerId, methodData)
   - createSubscription(customerId, priceId, metadata)
   - cancelSubscription(subscriptionId)
   - createPortalSession(customerId, returnUrl)
   - handleWebhook(payload, signature)
   - verifyWebhookSignature(payload, signature)
   ============================================================ */
'use strict';

/**
 * @typedef {Object} CustomerResult
 * @property {string} customerId
 * @property {string} email
 */

/**
 * @typedef {Object} SubscriptionResult
 * @property {string} subscriptionId
 * @property {string} status
 * @property {Date} currentPeriodEnd
 * @property {string} [clientSecret]
 */

/**
 * @typedef {Object} PortalSessionResult
 * @property {string} url
 */

/**
 * @typedef {Object} WebhookEvent
 * @property {string} type
 * @property {Object} data
 * @property {string} idempotencyKey
 */

/**
 * @typedef {Object} PaymentIntentInput
 * @property {number} amount - valor em centavos
 * @property {string} [currency]
 * @property {string} [customerId]
 * @property {Record<string, string>} [metadata]
 */

/**
 * @typedef {Object} PriceInput
 * @property {string} productName
 * @property {number} amount - valor em centavos
 * @property {string} [currency]
 * @property {string} [interval]
 * @property {Record<string, string>} [metadata]
 */

/**
 * @typedef {Object} PlanInput
 * @property {string} id
 * @property {string} name
 * @property {number} priceMonthly - preço mensal em reais (não centavos)
 */

/**
 * Superfície comum a todos os provedores.
 *
 * Cada provedor DEVE implementar o bloco `name`..`verifyWebhookSignature`.
 * Os extras abaixo são opcionais: nem todo PSP suporta todos eles, então os
 * consumidores precisam checar antes de usar.
 *
 * `createSubscription` recebe o plano já resolvido (em reais), não um
 * price_id: cada PSP precifica do seu jeito — Stripe em centavos, Asaas em
 * reais — e o adaptador faz essa conversão.
 *
 * @typedef {Object} PaymentProvider
 * @property {string} name
 * @property {(data: { email: string, name?: string, metadata?: Record<string, string> }) => Promise<CustomerResult>} createCustomer
 * @property {(customerId: string, plan: PlanInput, metadata: Record<string, string>) => Promise<SubscriptionResult>} createSubscription
 * @property {(subscriptionId: string) => Promise<void>} cancelSubscription
 * @property {(payload: string|Object, signature: string) => Promise<WebhookEvent>} handleWebhook
 * @property {(payload: string|Object, signature: string) => boolean} verifyWebhookSignature
 * @property {(customerId: string, returnUrl: string) => Promise<PortalSessionResult>} [createPortalSession]
 * @property {(params: PaymentIntentInput) => Promise<Object>} [createPaymentIntent]
 * @property {(params: PriceInput) => Promise<{ priceId: string }>} [createPrice]
 */

/** @type {Map<string, PaymentProvider>} */
const providers = new Map();

/**
 * Registra um provedor de pagamento.
 * @param {string} name
 * @param {PaymentProvider} provider
 * @returns {void}
 */
function registerProvider(name, provider) {
  providers.set(name, provider);
}

/**
 * Obtém provedor por nome.
 * @param {string} name
 * @returns {PaymentProvider}
 */
function getProvider(name) {
  const p = providers.get(name);
  if (!p) throw new Error(`Provedor de pagamento "${name}" não registrado`);
  return p;
}

/**
 * Lista nomes dos provedores registrados.
 * @returns {string[]}
 */
function listProviders() {
  return Array.from(providers.keys());
}

/**
 * Cria intent de pagamento (para checkout direto, se suportado).
 * @param {string} providerName
 * @param {PaymentIntentInput} params
 * @returns {Promise<Object>}
 */
async function createPaymentIntent(providerName, params) {
  const provider = getProvider(providerName);
  if (!provider.createPaymentIntent) throw new Error(`Provedor ${providerName} não suporta createPaymentIntent`);
  return provider.createPaymentIntent(params);
}

/**
 * Cria sessão de portal do cliente.
 * @param {string} providerName
 * @param {string} customerId
 * @param {string} returnUrl
 * @returns {Promise<PortalSessionResult>}
 */
async function createPortalSession(providerName, customerId, returnUrl) {
  const provider = getProvider(providerName);
  if (!provider.createPortalSession) {
    throw new Error(`Provedor ${providerName} não suporta portal do cliente`);
  }
  return provider.createPortalSession(customerId, returnUrl);
}

/**
 * Processa webhook com idempotência.
 * @param {string} providerName
 * @param {string|Object} payload
 * @param {string} signature
 * @returns {Promise<WebhookEvent>}
 */
async function handleWebhook(providerName, payload, signature) {
  const provider = getProvider(providerName);
  /** @type {WebhookEvent} */
  const event = await provider.handleWebhook(payload, signature);
  if (!event.idempotencyKey) throw new Error('Webhook não retornou idempotencyKey');
  return event;
}

module.exports = {
  registerProvider,
  getProvider,
  listProviders,
  createPaymentIntent,
  createPortalSession,
  handleWebhook,
};