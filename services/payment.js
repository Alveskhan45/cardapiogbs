// @ts-check
/* ============================================================
   Orquestrador de pagamentos: integra provedores + fluxos do SaaS

   Responsabilidades:
   - Criar/obter customer no provedor
   - Criar assinatura recorrente
   - Processar webhook (idempotente)
   - Ativar assinatura após pagamento confirmado
   - Portal do cliente
   ============================================================ */
'use strict';

const db = require('../db');
const paymentProviders = require('./payment-providers');
const stripe = require('./stripe');
const asaas = require('./asaas');
const logger = require('../lib/logger');

/** Provedor padrão por país/região */
const DEFAULT_PROVIDER = process.env.DEFAULT_PAYMENT_PROVIDER || 'stripe';

/**
 * @typedef {Object} TenantSettings
 * @property {string} [payment_provider]
 * @property {string} [payment_customer_id]
 * @property {string} [subscription_id]
 * @property {string} [subscription_provider]
 */

/**
 * @typedef {Object} Tenant
 * @property {string} [id]
 * @property {string} [name]
 * @property {string} [subdomain]
 * @property {TenantSettings} [settings]
 */

/**
 * @typedef {Object} AuthUser
 * @property {string} email
 * @property {string} [name]
 */

/**
 * @typedef {Object} TenantRequest
 * @property {string} tenantId
 * @property {AuthUser} user
 * @property {Tenant} tenant
 * @property {string} protocol
 * @property {(name: string) => string} get
 */

/**
 * @typedef {Object} Plan
 * @property {string} id
 * @property {string} name
 * @property {number} priceMonthly - preço mensal em reais
 */

/**
 * @typedef {Object} PaymentEventData
 * @property {string} [id]
 * @property {string} [subscription_id]
 * @property {string|Object} [subscription]
 */

/**
 * @typedef {Object} WebhookResult
 * @property {boolean} success
 * @property {import('./payment-providers').WebhookEvent} event
 * @property {boolean} [duplicate]
 */

/**
 * @typedef {Object} CheckoutResult
 * @property {string} provider
 * @property {string} [clientSecret]
 * @property {string} [paymentIntentId]
 */

/** Registra provedores */
const { registerProvider } = paymentProviders;
registerProvider('stripe', stripe);
registerProvider('asaas', asaas);

/**
 * Obtém ou cria customer no provedor para um tenant.
 * @param {TenantRequest} req
 * @returns {Promise<{ customerId: string, provider: string }>}
 */
async function getOrCreateCustomer(req) {
  const tenant = req.tenant;
  const providerName = tenant.settings?.payment_provider || DEFAULT_PROVIDER;
  
  // Verifica se já tem customer_id salvo nas settings do tenant
  let customerId = tenant.settings?.payment_customer_id;
  let providerNameUsed = tenant.settings?.payment_provider || DEFAULT_PROVIDER;
  
  if (!customerId) {
    const provider = paymentProviders.getProvider(providerNameUsed);
    const customer = await provider.createCustomer({
      email: req.user.email,
      name: req.user.name || tenant.name,
      metadata: { tenantId: req.tenantId, tenantSubdomain: req.tenant.subdomain ?? '' }
    });
    customerId = customer.customerId;
    
    // Salva no tenant
    await db.runTenant(req.tenantId, `
      UPDATE tenants SET settings = jsonb_set(
        COALESCE(settings, '{}'), 
        '{payment_customer_id}', 
        to_jsonb($1)
      ) WHERE id = $2`,
      [customerId, req.tenantId]
    );
    await db.runTenant(req.tenantId, `
      UPDATE tenants SET settings = jsonb_set(
        COALESCE(settings, '{}'), 
        '{payment_provider}', 
        to_jsonb($1)
      ) WHERE id = $2`,
      [providerName, req.tenantId]
    );
  }
  
  return { customerId, provider: providerNameUsed };
}

/**
 * Resolve um plano do catálogo.
 * @param {string} planId
 * @returns {Promise<Plan>}
 */
async function getPlan(planId) {
  const plans = await require('../services/billing').listPlans();
  const plan = plans.find((/** @type {Plan} */ p) => p.id === planId);
  if (!plan) throw new Error(`Plano ${planId} não encontrado`);
  return plan;
}

/**
 * Cria assinatura recorrente para o tenant.
 * @param {TenantRequest} req
 * @param {string} planId - 'starter' ou 'pro'
 * @returns {Promise<{ subscriptionId: string, status: string, clientSecret?: string, provider: string }>}
 */
async function createSubscription(req, planId) {
  const { customerId, provider: providerName } = await getOrCreateCustomer(req);

  const plan = await getPlan(planId);
  const provider = paymentProviders.getProvider(providerName);
  const subscription = await provider.createSubscription(customerId, plan, {
    tenantId: req.tenantId,
    plan: plan.id
  });
  
  // Salva subscription_id no tenant
  await db.runTenant(req.tenantId, `
    UPDATE tenants SET settings = jsonb_set(
      COALESCE(settings, '{}'), 
      '{subscription_id}', 
      to_jsonb($1)
    ) WHERE id = $2`,
    [subscription.subscriptionId, req.tenantId]
  );
  await db.runTenant(req.tenantId, `
    UPDATE tenants SET settings = jsonb_set(
      COALESCE(settings, '{}'), 
      '{subscription_provider}', 
      to_jsonb($1)
    ) WHERE id = $2`,
    [providerName, req.tenantId]
  );
  
  return { ...subscription, provider: providerName };
}

/**
 * Processa webhook de pagamento (idempotente).
 * @param {string} providerName
 * @param {string|Object} payload
 * @param {string} signature
 * @returns {Promise<WebhookResult>}
 */
async function handlePaymentWebhook(providerName, payload, signature) {
  const event = await paymentProviders.handleWebhook(providerName, payload, signature);
  
  // Idempotência: verifica se já processou este evento
  const processed = await db.runSuper(
    'SELECT 1 FROM webhook_events WHERE idempotency_key = $1',
    [event.idempotencyKey]
  );
  if (processed.rows.length) {
    return { success: true, event, duplicate: true };
  }
  
  // Registra evento processado
  await db.runSuper(
    `INSERT INTO webhook_events (idempotency_key, provider, event_type, payload, created_at)
     VALUES ($1, $2, $3, $4, NOW())
     ON CONFLICT (idempotency_key) DO NOTHING`,
    [event.idempotencyKey, providerName, event.type, JSON.stringify(event.data)]
  );
  
  // Processa evento baseado no tipo
  await processPaymentEvent(event, providerName);
  
  return { success: true, event };
}

/**
 * Processa evento de pagamento confirmado.
 * @param {import('./payment-providers').WebhookEvent} event
 * @param {string} providerName
 */
async function processPaymentEvent(event, providerName) {
  switch (event.type) {
    case 'invoice.payment_succeeded': // Stripe
    case 'PAYMENT_RECEIVED': // Asaas
      await activateSubscriptionFromWebhook(event.data, providerName);
      break;
    case 'invoice.payment_failed':
    case 'PAYMENT_OVERDUE':
      await handlePaymentFailed(event.data, providerName);
      break;
    case 'customer.subscription.deleted':
    case 'SUBSCRIPTION_CANCELLED':
      await handleSubscriptionCancelled(event.data, providerName);
      break;
  }
}

/**
 * Resolve o subscription_id de um payload de webhook entre provedores.
 * Stripe pode mandar `subscription` como string ou como objeto; Asaas usa
 * `subscription_id`.
 * @param {PaymentEventData} data
 * @returns {string|undefined}
 */
function resolveSubscriptionId(data) {
  const sub = data.subscription;
  if (typeof sub === 'string' && sub) return sub;
  if (sub && typeof sub === 'object') {
    const obj = /** @type {{ id?: string }} */ (sub);
    if (obj.id) return obj.id;
  }
  return data.subscription_id || (typeof data.id === 'string' ? data.id : undefined);
}

/**
 * Ativa assinatura após pagamento confirmado.
 * @param {PaymentEventData} data
 * @param {string} providerName
 */
async function activateSubscriptionFromWebhook(data, providerName) {
  const subscriptionId = resolveSubscriptionId(data);
  if (!subscriptionId) return;
  
  const pool = require('../db').superPool;
  const tenant = await pool.query(
    `SELECT id, subdomain FROM tenants WHERE settings->>'subscription_id' = $1`,
    [subscriptionId]
  );
  if (!tenant.rows.length) return;
  
  const tenantId = tenant.rows[0].id;
  const subdomain = tenant.rows[0].subdomain;
  
  await require('../services/contracting').activate(subscriptionId);
  
  // Atualiza tenant para active + subscription_expires_at
  await pool.query(
    `UPDATE tenants SET status = 'active', subscription_expires_at = NOW() + INTERVAL '30 days', updated_at = NOW()
     WHERE id = $1`,
    [tenantId]
  );
  
  // Invalida cache
  require('../middleware/tenantResolver').invalidateTenantCache(subdomain);
  
  logger.info('subscription_activated_webhook', { subscriptionId, tenantId, provider: providerName });
}

/**
 * Lida com pagamento falho.
 * @param {PaymentEventData} data
 * @param {string} providerName
 */
async function handlePaymentFailed(data, providerName) {
  const subscriptionId = resolveSubscriptionId(data);
  if (!subscriptionId) return;
  
  const pool = require('../db').superPool;
  const tenant = await pool.query(
    `SELECT id, subdomain FROM tenants WHERE settings->>'subscription_id' = $1`,
    [subscriptionId]
  );
  if (!tenant.rows.length) return;
  
  const tenantId = tenant.rows[0].id;
  
  // Marca como overdue, não cancela imediatamente (dá grace period)
  await require('../db').runSuper(
    `UPDATE tenants SET status = 'overdue', updated_at = NOW() WHERE id = $1`,
    [tenantId]
  );
  require('../middleware/tenantResolver').invalidateTenantCache(tenant.rows[0].subdomain);
  
  logger.warn('payment_failed', { subscriptionId, tenantId, provider: providerName });
}

/**
 * Lida com cancelamento de assinatura.
 * @param {PaymentEventData} data
 * @param {string} providerName
 */
async function handleSubscriptionCancelled(data, providerName) {
  const subscriptionId = resolveSubscriptionId(data);
  if (!subscriptionId) return;
  
  const pool = require('../db').superPool;
  const tenant = await pool.query(
    `SELECT id, subdomain FROM tenants WHERE settings->>'subscription_id' = $1`,
    [subscriptionId]
  );
  if (!tenant.rows.length) return;
  
  const tenantId = tenant.rows[0].id;
  await pool.query(
    `UPDATE tenants SET status = 'cancelled', subscription_expires_at = NULL, updated_at = NOW() WHERE id = $1`,
    [tenantId]
  );
  require('../middleware/tenantResolver').invalidateTenantCache(tenant.rows[0].subdomain);
  
  logger.info('subscription_cancelled_webhook', { subscriptionId, tenantId, provider: providerName });
}

/**
 * Cria sessão de portal do cliente.
 * @param {TenantRequest} req
 * @returns {Promise<import('./payment-providers').PortalSessionResult>}
 */
async function createCustomerPortal(req) {
  const { customerId, provider: providerName } = await getOrCreateCustomer(req);
  const provider = paymentProviders.getProvider(providerName);
  if (!provider.createPortalSession) {
    throw new Error(`Provedor ${providerName} não suporta portal do cliente`);
  }
  const returnUrl = `${req.protocol}://${req.get('host')}/admin/billing`;
  return provider.createPortalSession(customerId, returnUrl);
}

/**
 * Cria intent de pagamento para checkout.
 * @param {TenantRequest} req
 * @param {string} planId
 * @returns {Promise<CheckoutResult>}
 */
async function createCheckoutIntent(req, planId) {
  const { customerId, provider: providerName } = await getOrCreateCustomer(req);
  const provider = paymentProviders.getProvider(providerName);
  
const plan = await getPlan(planId);

  const amount = Math.round(plan.priceMonthly * 100); // Stripe usa centavos

  if (!provider.createPaymentIntent) {
    throw new Error(`Provedor ${providerName} não suporta intent de pagamento`);
  }
  const result = await provider.createPaymentIntent({
    amount: amount,
    currency: 'brl',
    customerId,
    metadata: { tenantId: req.tenantId, planId }
  });
  
  return { ...result, provider: providerName };
}

module.exports = {
  getOrCreateCustomer,
  createSubscription,
  handlePaymentWebhook,
  createCustomerPortal,
  createCheckoutIntent
};