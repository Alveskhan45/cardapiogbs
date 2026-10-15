/* Regressão: aprovação de pagamento pelo painel.
   Bug corrigido: a rota /api/super-admin/payments/:id/approve reusava $1
   como access_code E como tenant_id (uuid) — o Postgres estourava erro de
   sintaxe uuid, devolvendo 500 DEPOIS de a transação já ter aplicado plano
   e assinatura. Efeito em produção: admin via erro, mas o plano era ativado
   e a assinatura self-service nunca era liberada.
   Este teste fecha o buraco: cria a contratação inteira (signup →
   comprovante → aprovação) e confere 200 + access_code + subscription ativa. */
'use strict';

const request = require('supertest');
const crypto = require('crypto');
const db = require('../db');
const { signup, reportPayment } = require('../services/contracting');
const { hashPass } = require('../lib/passwords');
const { invalidateTenantCache } = require('../middleware/tenantResolver');
const { dbAvailableSync } = require('./setup');

const app = require('../server').app;

const RUN = crypto.randomBytes(4).toString('hex');
const EMAIL = `reg-${RUN}@exemplo.com`;
const SUPER_EMAIL = `reg-super-${RUN}@plataforma.com`;
const SENHA = 'SenhaForte123';

let tenantId = null;
let subscriptionId = null;
let proofId = null;
let superAdminId = null;
let superToken = null;

const DB_UP = dbAvailableSync();

beforeAll(async () => {
  if (!DB_UP) return;

  const sup = await signup({
    plan: 'starter',
    storeName: 'Loja Regressão Pagamento',
    email: EMAIL,
    password: SENHA,
    ownerName: 'Dona da Loja',
    phone: '11999990000'
  });
  subscriptionId = sup.subscriptionId;
  /* signup() não devolve tenantId: o vínculo vive na subscription */
  const subRow = await db.runSuper('SELECT tenant_id FROM subscriptions WHERE id = $1', [subscriptionId]);
  tenantId = subRow.rows[0].tenant_id;

  const rep = await reportPayment(sup.signupToken);
  proofId = rep.proofId;

  /* Super admin próprio: não depende de segredo de .env (que muda por
     ambiente) e isola o teste de lockout de tentativas falhas. */
  const sa = await db.runSuper(
    `INSERT INTO super_admins (email, password_hash, name, active)
     VALUES ($1, $2, 'Super Admin de Teste', TRUE)
     RETURNING id`,
    [SUPER_EMAIL, hashPass(SENHA)]
  );
  superAdminId = sa.rows[0].id;

  const login = await request(app)
    .post('/api/super-admin/login')
    .send({ email: SUPER_EMAIL, password: SENHA });
  superToken = login.body.token;
});

afterAll(async () => {
  if (!DB_UP) return;
  try {
    await db.runSuper('DELETE FROM super_admins WHERE id = $1', [superAdminId]);
    if (tenantId) await db.runSuper('DELETE FROM tenants WHERE id = $1', [tenantId]);
  } catch (e) {
    console.error('[test] falha na limpeza da regressão de pagamento:', e.message);
  } finally {
    invalidateTenantCache();
    await db.close();
  }
});

(DB_UP ? describe : describe.skip)('Aprovação de pagamento (caminho do dinheiro)', () => {
  test('aprovação responde 200 e devolve o código de acesso', async () => {
    expect(superToken).toBeTruthy();
    const res = await request(app)
      .post(`/api/super-admin/payments/${proofId}/approve`)
      .set('Authorization', `Bearer ${superToken}`);
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(typeof res.body.accessCode).toBe('string');
    expect(res.body.accessCode.length).toBeGreaterThan(0);
  });

  test('tenant sai de pending_approval para active com plano e vencimento', async () => {
    const r = await db.runSuper(
      'SELECT plan, status, subscription_expires_at FROM tenants WHERE id = $1',
      [tenantId]
    );
    expect(r.rows[0].plan).toBe('starter');
    expect(r.rows[0].status).toBe('active');
    expect(r.rows[0].subscription_expires_at).toBeTruthy();
  });

  test('subscription self-service fica ativa com código preenchido', async () => {
    const r = await db.runSuper(
      'SELECT status, access_code FROM subscriptions WHERE id = $1',
      [subscriptionId]
    );
    expect(r.rows[0].status).toBe('active');
    expect(r.rows[0].access_code).toBeTruthy();
  });

  test('aprovar duas vezes o mesmo comprovante devolve 409', async () => {
    const res = await request(app)
      .post(`/api/super-admin/payments/${proofId}/approve`)
      .set('Authorization', `Bearer ${superToken}`);
    expect(res.status).toBe(409);
  });
});
