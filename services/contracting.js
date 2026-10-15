/* ============================================================
   services/contracting.js — contratação self-service (mensal, PIX manual)

   Fluxo implementado (decidido com o cliente):
     1. O visitante preenche o formulário num plano da landing page
        (POST /api/public/signup). A loja é criada em TRIAL no plano
        gratuito — ou seja, a conta existe antes de pagar.
     2. A assinatura nasce como 'awaiting_payment'. O admin envia a chave
        PIX pelo WhatsApp (dados ficam visíveis no painel).
     3. O cliente paga e informa o pagamento; isso cria um payment_proof
        pendente e move a assinatura para 'payment_reported'.
     4. O admin aprova no painel: o plano é ativado por 30 dias e um
        código de acesso é gerado para ser entregue ao cliente.

   Regra do contrato: o frontend NUNCA decide que um pagamento foi pago.
   Só a aprovação explícita do Super Admin ativa os recursos pagos.
   ============================================================ */
'use strict';

const crypto = require('crypto');
const db = require('../db');
const { provisionTenant, slugify } = require('./provisioning');

const PLANS = ['free', 'starter', 'pro'];
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
// Sem 0/O/1/I para o cliente não errar ao dictate o código de acesso
const ACCESS_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

function contractingError(message, code = 'CONTRACT_INVALID') {
  const e = new Error(message);
  e.code = code;
  return e;
}

/* ------------------------------ dados de apoio ------------------------------ */

async function planInfo(plan) {
  const r = await db.runSuper(
    'SELECT id, name, price_monthly FROM plans WHERE id = $1',
    [plan]
  );
  if (!r.rows.length) return null;
  return {
    id: r.rows[0].id,
    name: r.rows[0].name,
    price: Number(r.rows[0].price_monthly)
  };
}

async function platformPix() {
  try {
    const r = await db.runSuper(
      'SELECT pix_key, pix_name, support_whatsapp FROM saas_templates WHERE id = $1',
      ['default']
    );
    const row = r.rows[0] || {};
    return {
      key: row.pix_key || '',
      name: row.pix_name || '',
      whatsapp: row.support_whatsapp || ''
    };
  } catch {
    return { key: '', name: '', whatsapp: '' };
  }
}

function generateAccessCode() {
  const bytes = crypto.randomBytes(8);
  let out = '';
  for (let i = 0; i < 8; i++) out += ACCESS_ALPHABET[bytes[i] % ACCESS_ALPHABET.length];
  return out;
}

/* Garante um subdomínio livre a partir do nome da loja */
async function uniqueSubdomain(name) {
  const base = slugify(name) || 'loja';
  for (let i = 0; i < 50; i++) {
    const candidate = i === 0 ? base : `${base}-${i + 1}`;
    const r = await db.runSuper(
      'SELECT 1 FROM tenants WHERE subdomain = $1 OR slug = $1 LIMIT 1',
      [candidate]
    );
    if (!r.rows.length) return candidate;
  }
  return `${base}-${crypto.randomBytes(3).toString('hex')}`;
}

/* ------------------------------- cadastro ---------------------------------- */

/* Cria a conta ANTES do pagamento: loja em trial/plano free + assinatura
   aguardando pagamento. */
async function signup(input = {}) {
  const plan = String(input.plan || '').trim().toLowerCase();
  if (!PLANS.includes(plan)) throw contractingError('Plano inválido');

  const storeName = String(input.storeName || '').trim();
  if (storeName.length < 2 || storeName.length > 120) {
    throw contractingError('Informe o nome da loja (entre 2 e 120 caracteres)');
  }

  const email = String(input.email || '').trim().toLowerCase();
  if (!EMAIL_RE.test(email) || email.length > 254) {
    throw contractingError('E-mail inválido');
  }

  const password = String(input.password || '');
  if (password.length < 8 || password.length > 128) {
    throw contractingError('A senha deve ter entre 8 e 128 caracteres');
  }

  const ownerName = String(input.ownerName || '').trim().slice(0, 120) || storeName;
  const phone = String(input.phone || '').replace(/[^\d+]/g, '').slice(0, 20);

  const info = await planInfo(plan);
  if (!info) throw contractingError('Plano não existe');

  const isFree = info.price === 0;
  const subdomain = await uniqueSubdomain(storeName);

  const provisioned = await provisionTenant({
    name: storeName,
    subdomain,
    slug: subdomain,
    // Sempre começa no gratuito: os recursos pagos só vêm na aprovação
    plan: 'free',
    status: isFree ? 'active' : 'trial',
    adminEmail: email,
    adminPassword: password,
    adminName: ownerName,
    phone,
    demo: false
  });

  const token = crypto.randomBytes(24).toString('hex');
  const status = isFree ? 'active' : 'awaiting_payment';

  const sub = await db.runSuper(
    `INSERT INTO subscriptions
       (tenant_id, plan, price_monthly, status, signup_token,
        contact_name, contact_email, contact_phone, activated_at, renews_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
     RETURNING id, created_at`,
    [
      provisioned.tenantId,
      info.id,
      info.price,
      status,
      token,
      ownerName,
      email,
      phone,
      isFree ? new Date() : null,
      isFree ? new Date(Date.now() + 30 * 24 * 60 * 60 * 1000) : null
    ]
  );

  await db.runSuper(
    `INSERT INTO saas_leads (plan, name, whatsapp, message, source, subscription_id, tenant_id)
     VALUES ($1, $2, $3, $4, 'signup', $5, $6)`,
    [
      info.id,
      ownerName,
      phone,
      `Contratação pela página de vendas — plano ${info.name}`,
      sub.rows[0].id,
      provisioned.tenantId
    ]
  );

  return {
    signupToken: token,
    subscriptionId: sub.rows[0].id,
    storeName,
    subdomain,
    login: email,
    plan: info.id,
    planName: info.name,
    price: info.price,
    status
  };
}

/* ------------------------------ acompanhamento ----------------------------- */

const STATUS_LABEL = {
  awaiting_payment: 'Aguardando pagamento',
  payment_reported: 'Pagamento informado',
  active: 'Plano ativo'
};

async function getByToken(token) {
  const t = String(token || '').trim();
  if (!/^[a-f0-9]{16,128}$/i.test(t)) return null;
  const r = await db.runSuper(
    `SELECT s.id, s.tenant_id, s.plan, s.price_monthly, s.status, s.access_code,
            s.created_at, s.activated_at, s.renews_at,
            s.contact_name, s.contact_email, s.contact_phone,
            t.name AS store_name, t.subdomain, t.plan AS current_plan,
            t.status AS tenant_status, p.name AS plan_name
     FROM subscriptions s
     JOIN tenants t ON t.id = s.tenant_id
     LEFT JOIN plans p ON p.id = s.plan
     WHERE s.signup_token = $1`,
    [t]
  );
  if (!r.rows.length) return null;
  const row = r.rows[0];
  return {
    subscriptionId: row.id,
    tenantId: row.tenant_id,
    storeName: row.store_name,
    subdomain: row.subdomain,
    login: row.contact_email,
    phone: row.contact_phone,
    plan: row.plan,
    planName: row.plan_name || row.plan,
    price: Number(row.price_monthly),
    status: row.status,
    statusLabel: STATUS_LABEL[row.status] || row.status,
    accessCode: row.status === 'active' ? row.access_code : '',
    currentPlan: row.current_plan,
    tenantStatus: row.tenant_status,
    createdAt: row.created_at,
    activatedAt: row.activated_at,
    renewsAt: row.renews_at
  };
}

/* Cliente informa que pagou: gera o comprovante pendente para o admin aprovar */
async function reportPayment(token) {
  const info = await getByToken(token);
  if (!info) throw contractingError('Contratação não encontrada', 'CONTRACT_NOT_FOUND');
  if (info.status === 'active') return { alreadyActive: true, contract: info };
  if (info.status === 'payment_reported') return { alreadyReported: true, contract: info };

  const r = await db.runSuper(
    `INSERT INTO payment_proofs (tenant_id, plan, amount, note, status, created_by)
     VALUES ($1, $2, $3, $4, 'pending', $5)
     RETURNING id`,
    [
      info.tenantId,
      info.plan,
      info.price,
      'Pagamento informado pelo cliente na página de vendas',
      info.login
    ]
  );

  await db.runSuper(
    `UPDATE subscriptions SET status = 'payment_reported' WHERE id = $1 AND status = 'awaiting_payment'`,
    [info.subscriptionId]
  );

  return { proofId: r.rows[0].id, contract: await getByToken(token) };
}

/* ----------------------------- painel do admin ----------------------------- */

async function listSubscriptions(status) {
  const where = status && status !== 'all' ? 'WHERE s.status = $1' : '';
  const r = await db.runSuper(
    `SELECT s.id, s.plan, s.price_monthly, s.status, s.access_code,
            s.contact_name, s.contact_email, s.contact_phone,
            s.created_at, s.activated_at, s.renews_at,
            t.name AS store_name, t.subdomain, t.plan AS current_plan, t.status AS tenant_status,
            p.name AS plan_name
     FROM subscriptions s
     JOIN tenants t ON t.id = s.tenant_id
     LEFT JOIN plans p ON p.id = s.plan
     ${where}
     ORDER BY s.created_at DESC
     LIMIT 100`,
    status && status !== 'all' ? [status] : []
  );
  return r.rows.map(row => ({
    id: row.id,
    storeName: row.store_name,
    subdomain: row.subdomain,
    login: row.contact_email,
    phone: row.contact_phone,
    contactName: row.contact_name,
    plan: row.plan,
    planName: row.plan_name || row.plan,
    price: Number(row.price_monthly),
    status: row.status,
    statusLabel: STATUS_LABEL[row.status] || row.status,
    accessCode: row.access_code,
    currentPlan: row.current_plan,
    tenantStatus: row.tenant_status,
    createdAt: row.created_at,
    activatedAt: row.activated_at,
    renewsAt: row.renews_at
  }));
}

/* Libera o acesso: ativa o plano por 30 dias e gera o código de acesso.
   Idempotente — ativar duas vezes não duplica os 30 dias. */
async function activate(subscriptionId) {
  const r = await db.runSuper(
    'SELECT id, tenant_id, plan, price_monthly, status FROM subscriptions WHERE id = $1',
    [subscriptionId]
  );
  if (!r.rows.length) throw contractingError('Assinatura não encontrada', 'SUBSCRIPTION_NOT_FOUND');
  const sub = r.rows[0];

  // Já ativa: devolve o estado atual SEM somar novos 30 dias (idempotente)
  if (sub.status === 'active') {
    const cur = await db.runSuper(
      'SELECT access_code, renews_at FROM subscriptions WHERE id = $1',
      [sub.id]
    );
    return {
      tenantId: sub.tenant_id,
      plan: sub.plan,
      price: Number(sub.price_monthly),
      free: Number(sub.price_monthly) === 0,
      accessCode: (cur.rows[0] || {}).access_code || '',
      renewsAt: (cur.rows[0] || {}).renews_at || null,
      alreadyActive: true
    };
  }

  const accessCode = generateAccessCode();
  const free = Number(sub.price_monthly) === 0;

  const result = await db.withSuperTransaction(async ({ q }) => {
    await q(
      `UPDATE tenants
          SET plan = $1, status = 'active',
              subscription_expires_at = GREATEST(COALESCE(subscription_expires_at, NOW()), NOW()) + INTERVAL '30 days',
              trial_ends_at = NULL, updated_at = NOW()
        WHERE id = $2 AND deleted_at IS NULL
        RETURNING id, name, subdomain`,
      [sub.plan, sub.tenant_id]
    );
    const updated = await q(
      `UPDATE subscriptions
          SET status = 'active',
              activated_at = COALESCE(activated_at, NOW()),
              renews_at = COALESCE(renews_at, NOW()) + INTERVAL '30 days',
              access_code = CASE WHEN access_code = '' THEN $1 ELSE access_code END
        WHERE id = $2
        RETURNING access_code, renews_at`,
      [accessCode, sub.id]
    );
    return updated.rows[0];
  });

  return {
    tenantId: sub.tenant_id,
    plan: sub.plan,
    price: Number(sub.price_monthly),
    free,
    accessCode: result.access_code,
    renewsAt: result.renews_at
  };
}

module.exports = {
  signup,
  getByToken,
  reportPayment,
  listSubscriptions,
  activate,
  platformPix,
  planInfo,
  generateAccessCode,
  contractingError,
  STATUS_LABEL,
  PLANS
};