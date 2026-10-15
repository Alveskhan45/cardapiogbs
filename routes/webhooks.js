// @ts-check
/* ============================================================
   Webhooks de pagamento (Stripe, Asaas)

   Recebe eventos dos provedores e processa com idempotência.
   Rotas:
   - POST /api/webhooks/stripe
   - POST /api/webhooks/stripe
   ============================================================ */
'use strict';

const express = require('express');
const router = express.Router();
const payment = require('../services/payment');
const logger = require('../lib/logger');

/**
 * @typedef {express.Request & { rawBody?: string }} RawRequest
 */

/**
 * Garante que `req.rawBody` exista.
 *
 * O corpo já é consumido pelo `express.json()` global (server.js), então o
 * stream chegou ao fim e `req.on('end')` não dispara mais: escutar o stream
 * aqui deixaria a requisição travada. O `verify` do express.json guarda o
 * corpo cru; o fallback para o stream cobre o uso deste router sem o
 * middleware global (ex.: testes isolados).
 *
 * @param {RawRequest} req
 * @param {express.Response} res
 * @param {express.NextFunction} next
 * @returns {void}
 */
function rawBodyParser(req, res, next) {
  if (typeof req.rawBody === 'string') {
    next();
    return;
  }

  try {
    req.setEncoding('utf8');
  } catch {
    // Em testes, req pode não ter setEncoding
  }
  let data = '';
  req.on('data', chunk => { data += chunk; });
  req.on('end', () => {
    req.rawBody = data;
    try { req.body = data ? JSON.parse(data) : {}; } catch { req.body = {}; }
    next();
  });
  req.on('error', next);
}

/**
 * @param {RawRequest} req
 * @param {string} header
 * @returns {string | undefined}
 */
function readSignature(req, header) {
  const value = req.headers[header];
  return Array.isArray(value) ? value[0] : value;
}

/** POST /api/webhooks/stripe */
router.post('/stripe', rawBodyParser, async (req, res) => {
  const raw = /** @type {RawRequest} */ (req);
  const signature = readSignature(raw, 'stripe-signature');
  if (!signature) {
    logger.warn('webhook_stripe_sem_assinatura');
    res.status(400).send('Missing stripe-signature header');
    return;
  }
  try {
    const result = await payment.handlePaymentWebhook('stripe', raw.rawBody ?? '', signature);
    res.json({ received: true, duplicate: result.duplicate });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.error('webhook_stripe_error', { message });
    res.status(400).send(`Webhook error: ${message}`);
  }
});

/** POST /api/webhooks/asaas */
router.post('/asaas', rawBodyParser, async (req, res) => {
  const raw = /** @type {RawRequest} */ (req);
  const signature = readSignature(raw, 'asaas-signature') || readSignature(raw, 'x-asaas-signature');
  if (!signature) {
    logger.warn('webhook_asaas_sem_assinatura');
    res.status(400).send('Missing asaas-signature header');
    return;
  }
  try {
    const result = await payment.handlePaymentWebhook('asaas', raw.rawBody ?? '', signature);
    res.json({ received: true, duplicate: result.duplicate });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.error('webhook_asaas_error', { message });
    res.status(400).send(`Webhook error: ${message}`);
  }
});

module.exports = router;