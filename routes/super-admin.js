/* ============================================================
   routes/super-admin.js — Fase 6.1 do plano

   Prefixo /api/super-admin (rota SEM tenant — o painel da
   plataforma é global):
     POST   /login
     GET    /tenants
     GET    /tenants/:id
     POST   /tenants
     PUT    /tenants/:id
     DELETE /tenants/:id
     POST   /tenants/:id/impersonate
     GET    /stats
     GET    /revenue
   ============================================================ */
'use strict';

const express = require('express');
const db = require('../db');
const { verifyPass, hashPass, validatePasswordStrength } = require('../lib/passwords');
const { requireAuth, requireSuperAdmin, signSuperToken, issueImpersonationToken } = require('../middleware/auth');
const { provisionTenant, validate: validateProvisioning } = require('../services/provisioning');
const billing = require('../services/billing');
const contracting = require('../services/contracting');
const { invalidateTenantCache } = require('../middleware/tenantResolver');
const { superLoginLimiter, tenantCreateLimiter } = require('../middleware/rateLimit');
const logger = require('../lib/logger');
const metrics = require('../lib/metrics');

const router = express.Router();

const STATUSES = ['active', 'trial', 'pending_approval', 'suspended', 'cancelled'];
const PLANS = ['free', 'starter', 'pro'];

/* Trilha de auditoria: toda ação do painel da plataforma cai aqui.
   Melhor-esforço: nunca quebra a operação principal. */
async function audit(req, action, tenantId, details) {
  try {
    await db.runSuper(
      `INSERT INTO super_admin_audit (actor_id, actor_email, action, tenant_id, details, ip)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [
        (req.user && req.user.sub) || null,
        (req.user && req.user.email) || '',
        action,
        tenantId || null,
        details || {},
        req.ip || ''
      ]
    );
  } catch (e) {
    console.error('[super.audit]', e.message);
  }
}

function uuidRe(v) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(String(v || ''));
}

/* ------------------- login do painel da plataforma ------------------- */
router.post('/login', superLoginLimiter, async (req, res) => {
  const email = String((req.body && req.body.email) || '').trim().toLowerCase().slice(0, 254);
  const password = String((req.body && req.body.password) || '').slice(0, 256);
  if (!email || !password) return res.status(400).json({ ok: false, error: 'Informe e-mail e senha' });
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return res.status(400).json({ ok: false, error: 'E-mail inválido' });
  }
  if (password.length < 8 || password.length > 128) {
    return res.status(400).json({ ok: false, error: 'Senha deve ter entre 8 e 128 caracteres' });
  }

  const MAX_FAILED_ATTEMPTS = 5;
  const LOCKOUT_DURATION_MS = 15 * 60 * 1000; // 15 minutos

  try {
    const r = await db.runSuper(
      'SELECT id, email, name, password_hash, active, failed_login_attempts, locked_until FROM super_admins WHERE lower(email) = $1',
      [email]
    );
    const sa = r.rows[0];
    
    // Verifica lockout
    if (sa && sa.locked_until && new Date(sa.locked_until).getTime() > Date.now()) {
      const remainingMs = new Date(sa.locked_until).getTime() - Date.now();
      const remainingMin = Math.ceil(remainingMs / 60000);
      return res.status(429).json({ 
        ok: false, 
        error: `Conta temporariamente bloqueada. Tente novamente em ${remainingMin} minuto(s).`,
        code: 'ACCOUNT_LOCKED',
        retryAfter: remainingMin * 60
      });
    }
    
    if (!sa || !sa.active || !verifyPass(password, sa.password_hash)) {
      // Incrementa tentativas falhadas se super-admin existe
      if (sa) {
        const newAttempts = (sa.failed_login_attempts || 0) + 1;
        const updates = ['failed_login_attempts = ' + newAttempts];
        if (newAttempts >= MAX_FAILED_ATTEMPTS) {
          const lockedUntil = new Date(Date.now() + LOCKOUT_DURATION_MS).toISOString();
          updates.push('locked_until = \'' + lockedUntil + '\'');
        }
        await db.runSuper(
          `UPDATE super_admins SET ${updates.join(', ')} WHERE id = $1`,
          [sa.id]
        );
      }
      return res.status(401).json({ ok: false, error: 'E-mail ou senha incorretos' });
    }

    // Login bem-sucedido: reseta tentativas falhadas e lockout
    await db.runSuper(
      'UPDATE super_admins SET failed_login_attempts = 0, locked_until = NULL WHERE id = $1',
      [sa.id]
    );

    res.json({ ok: true, token: signSuperToken(sa), user: { id: sa.id, email: sa.email, name: sa.name } });
  } catch (e) {
    console.error('[super.login]', e.message);
    res.status(500).json({ ok: false, error: 'Erro ao autenticar' });
  }
});

/* Tudo abaixo exige token de super-admin */
router.use(requireAuth, requireSuperAdmin);

/* Tudo abaixo exige token de super-admin */
router.use(requireAuth, requireSuperAdmin);

/* ------------------- conta do super-admin (aba Configurações) ------------------- */
router.get('/account', async (req, res) => {
  try {
    const r = await db.runSuper(
      'SELECT id, email, name, active, created_at FROM super_admins WHERE id = $1',
      [req.user.sub]
    );
    const sa = r.rows[0];
    if (!sa) return res.status(404).json({ ok: false, error: 'Conta não encontrada' });
    res.json({ ok: true, account: sa });
  } catch (e) {
    console.error('[super.accountGet]', e.message);
    res.status(500).json({ ok: false, error: 'Erro ao carregar conta' });
  }
});

router.put('/account', async (req, res) => {
  const body = req.body || {};
  const name = body.name === undefined ? null : String(body.name).trim().slice(0, 200);
  const email = body.email === undefined ? null : String(body.email).trim().toLowerCase().slice(0, 254);
  if (email !== null && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return res.status(400).json({ ok: false, error: 'E-mail inválido' });
  }
  if (name === null && email === null) {
    return res.status(400).json({ ok: false, error: 'Nada para atualizar' });
  }
  try {
    const r = await db.runSuper(
      `UPDATE super_admins
         SET name = COALESCE($1, name),
             email = COALESCE($2, email)
       WHERE id = $3
       RETURNING id, email, name, active, created_at`,
      [name, email, req.user.sub]
    );
    if (!r.rows.length) return res.status(404).json({ ok: false, error: 'Conta não encontrada' });
    await audit(req, 'account_update', null, { fields: Object.keys(req.body || {}) });
    res.json({ ok: true, account: r.rows[0] });
  } catch (e) {
    if (e && e.code === '23505') return res.status(409).json({ ok: false, error: 'Este e-mail já está em uso' });
    console.error('[super.accountUpdate]', e.message);
    res.status(500).json({ ok: false, error: 'Erro ao salvar conta' });
  }
});

router.put('/account/password', async (req, res) => {
  const body = req.body || {};
  const current = String(body.current || '').slice(0, 256);
  const password = String(body.password || '').slice(0, 256);
  if (!current) return res.status(400).json({ ok: false, error: 'Informe a senha atual' });
  const pwdCheck = validatePasswordStrength(password);
  if (!pwdCheck.valid) return res.status(400).json({ ok: false, error: 'Senha fraca: ' + pwdCheck.errors.join(', ') });
  try {
    const r = await db.runSuper('SELECT id, password_hash FROM super_admins WHERE id = $1', [req.user.sub]);
    const sa = r.rows[0];
    if (!sa || !verifyPass(current, sa.password_hash)) {
      return res.status(401).json({ ok: false, error: 'Senha atual incorreta' });
    }
    await db.runSuper('UPDATE super_admins SET password_hash = $1 WHERE id = $2', [hashPass(password), sa.id]);
    await audit(req, 'account_password', null, {});
    res.json({ ok: true });
  } catch (e) {
    console.error('[super.accountPassword]', e.message);
    res.status(500).json({ ok: false, error: 'Erro ao alterar senha' });
  }
});

router.get('/tenants/check-subdomain', async (req, res) => {
  const subdomain = String(req.query.value || '').trim().toLowerCase();
  const { errors } = validateProvisioning({
    name: 'Loja de teste',
    subdomain,
    adminEmail: 'check@example.com',
    plan: 'free'
  });
  if (errors.some(error => error.includes('Subdomínio') || error.includes('reservado'))) {
    return res.status(400).json({ ok: true, available: false, error: errors[0] });
  }

  try {
    const result = await db.runSuper(
      'SELECT 1 FROM tenants WHERE subdomain = $1 OR slug = $1 LIMIT 1',
      [subdomain]
    );
    res.json({
      ok: true,
      available: !result.rows.length,
      message: result.rows.length ? 'Este endereço já está em uso' : 'Endereço disponível'
    });
  } catch (error) {
    console.error('[super.checkSubdomain]', error.message);
    res.status(500).json({ ok: false, error: 'Não foi possível verificar o endereço' });
  }
});

/* ------------------- listar tenants ------------------- */
router.get('/tenants', async (req, res) => {
  const search = String(req.query.search || '').trim();
  const status = String(req.query.status || '').trim();
  const plan = String(req.query.plan || '').trim();
  const page = Math.max(1, parseInt(req.query.page || '1', 10));
  const perPage = Math.min(100, Math.max(1, parseInt(req.query.per_page || '50', 10)));
  const offset = (page - 1) * perPage;

  const where = ['t.deleted_at IS NULL'];
  const params = [];
  if (search) {
    params.push('%' + search.toLowerCase() + '%');
    where.push(`(lower(t.name) LIKE $${params.length} OR lower(t.subdomain) LIKE $${params.length})`);
  }
  if (STATUSES.includes(status)) { params.push(status); where.push(`t.status = $${params.length}`); }
  if (PLANS.includes(plan)) { params.push(plan); where.push(`t.plan = $${params.length}`); }

  const clause = where.join(' AND ');
  const limitParams = [...params, perPage, offset];

  try {
    // Com paginação para performance em muitos tenants
    const [count, list] = await Promise.all([
      db.runSuper(`SELECT COUNT(*)::int AS c FROM tenants t WHERE ${clause}`, params),
      db.runSuper(
        `SELECT t.id, t.name, t.subdomain, t.slug, t.plan, t.status, t.created_at,
                t.cnpj, t.phone, t.primary_color,
                t.trial_ends_at, t.subscription_expires_at,
                (SELECT COUNT(*) FROM products p WHERE p.tenant_id = t.id) AS products,
                (SELECT COUNT(*) FROM orders o WHERE o.tenant_id = t.id AND o.created_at >= NOW() - INTERVAL '30 days') AS orders_30d,
                (SELECT COALESCE(SUM((o.data->>'total')::numeric),0) FROM orders o WHERE o.tenant_id = t.id AND o.created_at >= NOW() - INTERVAL '30 days') AS revenue_30d,
                (SELECT COUNT(*) FROM users u WHERE u.tenant_id = t.id AND u.active) AS users
         FROM tenants t
         WHERE ${clause}
         ORDER BY t.created_at DESC
         LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
        limitParams
      )
    ]);

    res.json({
      ok: true,
      page,
      perPage,
      total: count.rows[0].c,
      totalPages: Math.ceil(count.rows[0].c / perPage),
      tenants: list.rows.map(t => ({
        id: t.id,
        name: t.name,
        subdomain: t.subdomain,
        slug: t.slug,
        plan: t.plan,
        status: t.status,
        products: t.products,
        orders30d: t.orders_30d,
        revenue30d: Number(t.revenue_30d || 0),
        users: t.users,
        createdAt: t.created_at,
        cnpj: t.cnpj || '',
        phone: t.phone || '',
        primaryColor: t.primary_color || '',
        trialEndsAt: t.trial_ends_at,
        subscriptionExpiresAt: t.subscription_expires_at
      }))
    });
  } catch (e) {
    console.error('[super.tenants]', e.message);
    res.status(500).json({ ok: false, error: 'Erro ao listar tenants' });
  }
});

/* ------------------- detalhe do tenant ------------------- */
router.get('/tenants/:id', async (req, res) => {
  const id = String(req.params.id || '');
  if (!uuidRe(id)) return res.status(404).json({ ok: false, error: 'Tenant não encontrado' });

  try {
    const t = await db.runSuper(
      `SELECT id, name, subdomain, slug, plan, status, settings, created_at, updated_at,
              trial_ends_at, subscription_expires_at
       FROM tenants WHERE id = $1`,
      [id]
    );
    if (!t.rows.length) return res.status(404).json({ ok: false, error: 'Tenant não encontrado' });

    const [users, products, orders, plan] = await Promise.all([
      db.runSuper('SELECT id, email, name, role, active, last_login, created_at FROM users WHERE tenant_id = $1 ORDER BY created_at', [id]),
      db.runSuper('SELECT COUNT(*)::int AS c FROM products WHERE tenant_id = $1', [id]),
      db.runSuper('SELECT COUNT(*)::int AS total, COUNT(*) FILTER (WHERE created_at >= NOW() - INTERVAL \'30 days\')::int AS last30 FROM orders WHERE tenant_id = $1', [id]),
      db.runSuper('SELECT id, name, price_monthly, limits, features FROM plans WHERE id = $1', [t.rows[0].plan])
    ]);

    res.json({
      ok: true,
      tenant: t.rows[0],
      users: users.rows,
      counts: { products: products.rows[0].c, orders: orders.rows[0].total, orders30d: orders.rows[0].last30 },
      plan: plan.rows[0] || null
    });
  } catch (e) {
    console.error('[super.tenantDetail]', e.message);
    res.status(500).json({ ok: false, error: 'Erro ao buscar tenant' });
  }
});

/* ------------------- criar tenant (provisioning) ------------------- */
router.post('/tenants', tenantCreateLimiter, async (req, res) => {
  try {
    const result = await provisionTenant(req.body || {});
    invalidateTenantCache(result.tenant.subdomain);
    invalidateTenantCache(result.tenant.slug);
    invalidateTenantCache(result.tenantId);
    await audit(req, 'tenant_created', result.tenantId, { subdomain: result.tenant.subdomain, plan: result.tenant.plan });
    res.status(201).json({ ok: true, ...result });
  } catch (e) {
    if (e.code === 'TENANT_INVALID') {
      return res.status(400).json({ ok: false, code: e.code, error: e.message });
    }
    // violação de unicidade do Postgres (23505)
    if (e.code === '23505') {
      return res.status(409).json({ ok: false, error: 'Subdomínio ou slug já existe' });
    }
    console.error('[super.createTenant]', e.message);
    res.status(500).json({ ok: false, error: 'Erro ao criar tenant' });
  }
});

/* ------------------- atualizar tenant (plano/status/settings) ------------------- */
router.put('/tenants/:id', async (req, res) => {
  const id = String(req.params.id || '');
  if (!uuidRe(id)) return res.status(404).json({ ok: false, error: 'Tenant não encontrado' });
  const body = req.body || {};

  const fields = [];
  const params = [];
  if (body.name !== undefined) { params.push(String(body.name).trim()); fields.push(`name = $${params.length}`); }
  if (body.plan !== undefined) {
    if (!PLANS.includes(body.plan)) return res.status(400).json({ ok: false, error: 'Plano inválido' });
    params.push(body.plan); fields.push(`plan = $${params.length}`);
  }
  if (body.status !== undefined) {
    if (!STATUSES.includes(body.status)) return res.status(400).json({ ok: false, error: 'Status inválido' });
    params.push(body.status); fields.push(`status = $${params.length}`);
  }
  if (body.settings !== undefined) {
    params.push(body.settings || {}); fields.push(`settings = $${params.length}`);
  }
  for (const col of ['cnpj', 'phone', 'address', 'primary_color']) {
    if (body[col] !== undefined) { params.push(String(body[col] || '')); fields.push(`${col} = $${params.length}`); }
  }
  if (body.primaryColor !== undefined) { params.push(String(body.primaryColor || '')); fields.push(`primary_color = $${params.length}`); }
  for (const col of ['trial_ends_at', 'subscription_expires_at']) {
    if (body[col] !== undefined) { params.push(body[col] || null); fields.push(`${col} = $${params.length}`); }
  }
  if (!fields.length) return res.status(400).json({ ok: false, error: 'Nada para atualizar' });

  try {
    const r = await db.runSuper(
      `UPDATE tenants SET ${fields.join(', ')}, updated_at = NOW()
       WHERE id = $${params.length + 1} RETURNING id, name, subdomain, plan, status, settings`,
      [...params, id]
    );
    if (!r.rows.length) return res.status(404).json({ ok: false, error: 'Tenant não encontrado' });

    // Invalida cache do tenant (subdomain/slug/id) pois plan/status mudaram
    invalidateTenantCache(r.rows[0].subdomain);
    invalidateTenantCache(r.rows[0].slug);
    invalidateTenantCache(id);
    const changed = {};
    if (body.plan !== undefined) changed.plan = body.plan;
    if (body.status !== undefined) changed.status = body.status;
    await audit(req, body.status !== undefined ? `tenant_${body.status}` : 'tenant_updated', id, changed);
    res.json({ ok: true, tenant: r.rows[0] });
  } catch (e) {
    console.error('[super.updateTenant]', e.message);
    res.status(500).json({ ok: false, error: 'Erro ao atualizar tenant' });
  }
});

/* ------------------- aprovar/rejeitar tenant pendente ------------------- */
router.post('/tenants/:id/approve', async (req, res) => {
  const id = String(req.params.id || '');
  if (!uuidRe(id)) return res.status(404).json({ ok: false, error: 'Tenant não encontrado' });
  const { action } = req.body || {}; // 'approve' ou 'reject'
  if (!['approve', 'reject'].includes(action)) {
    return res.status(400).json({ ok: false, error: 'Ação inválida (approve ou reject)' });
  }

  try {
    const t = await db.runSuper(
      `SELECT id, name, subdomain, plan, status FROM tenants WHERE id = $1`,
      [id]
    );
    if (!t.rows.length) return res.status(404).json({ ok: false, error: 'Tenant não encontrado' });
    const tenant = t.rows[0];
    
    if (tenant.status !== 'pending_approval') {
      return res.status(400).json({ ok: false, error: 'Tenant não está pendente de aprovação' });
    }

    let newStatus, subscriptionExpiresAt;
    if (action === 'approve') {
      newStatus = 'active';
      // 30 dias a partir de agora para planos mensais
      subscriptionExpiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();
    } else {
      newStatus = 'cancelled';
      subscriptionExpiresAt = null;
    }

    const r = await db.runSuper(
      `UPDATE tenants SET status = $1, subscription_expires_at = $2, updated_at = NOW()
       WHERE id = $3 RETURNING id, name, subdomain, plan, status, subscription_expires_at`,
      [newStatus, subscriptionExpiresAt, id]
    );

    // Invalida cache
    invalidateTenantCache(r.rows[0].subdomain);
    invalidateTenantCache(r.rows[0].slug);
    invalidateTenantCache(id);

    await audit(req, `tenant_${action}`, id, { plan: tenant.plan });
    
    res.json({ 
      ok: true, 
      tenant: r.rows[0],
      message: action === 'approve' ? 'Loja aprovada e ativada por 30 dias' : 'Loja rejeitada'
    });
  } catch (e) {
    console.error('[super.approveTenant]', e.message);
    res.status(500).json({ ok: false, error: 'Erro ao processar aprovação' });
  }
});

/* ------------------- remover tenant (soft delete) ------------------- */
router.delete('/tenants/:id', async (req, res) => {
  const id = String(req.params.id || '');
  if (!uuidRe(id)) return res.status(404).json({ ok: false, error: 'Tenant não encontrado' });
  const force = String(req.query.force || '') === '1';

  try {
    if (force) {
      const del = await db.runSuper('DELETE FROM tenants WHERE id = $1 RETURNING id, subdomain, slug', [id]);
      if (!del.rows.length) return res.status(404).json({ ok: false, error: 'Tenant não encontrado' });
      invalidateTenantCache(del.rows[0].subdomain);
      invalidateTenantCache(del.rows[0].slug);
      invalidateTenantCache(id);
      return res.json({ ok: true, deleted: 'hard' });
    }

    const r = await db.runSuper(
      `UPDATE tenants SET status = 'cancelled', deleted_at = NOW(), updated_at = NOW()
       WHERE id = $1 RETURNING id, name, subdomain, slug`,
      [id]
    );
    if (!r.rows.length) return res.status(404).json({ ok: false, error: 'Tenant não encontrado' });
    invalidateTenantCache(r.rows[0].subdomain);
    invalidateTenantCache(r.rows[0].slug);
    invalidateTenantCache(id);
    res.json({ ok: true, deleted: 'soft', tenant: r.rows[0] });
  } catch (e) {
    console.error('[super.deleteTenant]', e.message);
    res.status(500).json({ ok: false, error: 'Erro ao remover tenant' });
  }
});

/* ------------------- impersonar admin do tenant ------------------- */
router.post('/tenants/:id/impersonate', async (req, res) => {
  const id = String(req.params.id || '');
  if (!uuidRe(id)) return res.status(404).json({ ok: false, error: 'Tenant não encontrado' });

  try {
    const t = await db.runSuper('SELECT id, subdomain, name, status FROM tenants WHERE id = $1 AND deleted_at IS NULL', [id]);
    if (!t.rows.length) return res.status(404).json({ ok: false, error: 'Tenant não encontrado' });
    if (t.rows[0].status !== 'active') return res.status(400).json({ ok: false, error: 'Tenant não está ativo' });

    const u = await db.runSuper(
      `SELECT id, email, name, role, permissions FROM users
       WHERE tenant_id = $1 AND active AND role = 'admin'
       ORDER BY created_at LIMIT 1`,
      [id]
    );
    if (!u.rows.length) return res.status(404).json({ ok: false, error: 'Tenant sem admin ativo' });

    const user = u.rows[0];
    res.json({
      ok: true,
      token: issueImpersonationToken(user, id, req.user.sub),
      tenant: { id, subdomain: t.rows[0].subdomain, name: t.rows[0].name },
      user: { id: user.id, email: user.email, name: user.name }
    });
  } catch (e) {
    console.error('[super.impersonate]', e.message);
    res.status(500).json({ ok: false, error: 'Erro ao impersonar' });
  }
});

/* ------------------- métricas do processo (observabilidade) ------------------- */
/* Escopo da instância: contadores em memória + percentis de latência.
   Autenticado como o resto do painel (requireSuperAdmin acima). */
router.get('/runtime', async (req, res) => {
  try {
    res.json({
      ok: true,
      runtime: metrics.snapshot(),
      node: {
        version: process.version,
        uptime_s: Math.floor(process.uptime()),
        memory_rss_mb: Math.round(process.memoryUsage().rss / 1024 / 1024),
        env: process.env.NODE_ENV || 'development'
      }
    });
  } catch (e) {
    logger.routeError(req, '/api/super-admin/runtime', e);
    res.status(500).json({ ok: false, error: 'Erro ao coletar métricas' });
  }
});

/* ------------------- métricas globais ------------------- */
router.get('/stats', async (req, res) => {
  try {
    res.json({ ok: true, stats: await billing.platformStats() });
  } catch (e) {
    logger.routeError(req, '/api/super-admin/stats', e);
    res.status(500).json({ ok: false, error: 'Erro ao calcular métricas' });
  }
});

router.get('/revenue', async (req, res) => {
  try {
    res.json({ ok: true, revenue: await billing.revenueByTenant(), revenueByPlan: await billing.revenueByPlan(), mrr: await billing.mrr(), plans: await billing.listPlans() });
  } catch (e) {
    logger.routeError(req, '/api/super-admin/revenue', e);
    res.status(500).json({ ok: false, error: 'Erro ao calcular faturamento' });
  }
});

/* ------------------- planos (aba Planos & Precificação) ------------------- */
router.get('/plans', async (req, res) => {
  try {
    res.json({ ok: true, plans: await billing.listPlans() });
  } catch (e) {
    console.error('[super.plans]', e.message);
    res.status(500).json({ ok: false, error: 'Erro ao listar planos' });
  }
});

/* Edita preço/limites/recursos de um plano — recalcula o MRR na hora */
router.put('/plans/:id', async (req, res) => {
  const id = String(req.params.id || '');
  const body = req.body || {};
  const fields = [];
  const params = [];
  if (!PLANS.includes(id)) return res.status(404).json({ ok: false, error: 'Plano não encontrado' });
  if (body.name !== undefined) { params.push(String(body.name).trim().slice(0, 100)); fields.push(`name = $${params.length}`); }
  if (body.priceMonthly !== undefined) {
    const v = Number(body.priceMonthly);
    if (!Number.isFinite(v) || v < 0) return res.status(400).json({ ok: false, error: 'Preço inválido' });
    params.push(v); fields.push(`price_monthly = $${params.length}`);
  }
  if (body.limits !== undefined) {
    if (!body.limits || typeof body.limits !== 'object' || Array.isArray(body.limits)) {
      return res.status(400).json({ ok: false, error: 'Limites inválidos' });
    }
    const limits = {};
    for (const [resource, value] of Object.entries(body.limits)) {
      if (!['products', 'orders_month', 'users', 'bairros', 'storage_mb'].includes(resource)) {
        return res.status(400).json({ ok: false, error: `Recurso de limite inválido: ${resource}` });
      }
      const limit = Number(value);
      if (!Number.isInteger(limit) || limit < -1) {
        return res.status(400).json({ ok: false, error: `Limite inválido para ${resource}` });
      }
      limits[resource] = limit;
    }
    params.push(limits); fields.push(`limits = $${params.length}`);
  }
  if (body.features !== undefined) {
    if (!body.features || typeof body.features !== 'object' || Array.isArray(body.features)) {
      return res.status(400).json({ ok: false, error: 'Recursos do plano inválidos' });
    }
    for (const value of Object.values(body.features)) {
      if (typeof value !== 'boolean') return res.status(400).json({ ok: false, error: 'Os recursos do plano devem ser booleanos' });
    }
    params.push(body.features); fields.push(`features = $${params.length}`);
  }
  if (!fields.length) return res.status(400).json({ ok: false, error: 'Nada para atualizar' });
  try {
    const r = await db.runSuper(
      `UPDATE plans SET ${fields.join(', ')} WHERE id = $${params.length + 1}
       RETURNING id, name, price_monthly, limits, features`,
      [...params, id]
    );
    if (!r.rows.length) return res.status(404).json({ ok: false, error: 'Plano não encontrado' });
    await audit(req, 'plans_updated', null, { plan: id, fields: Object.keys(body) });
    res.json({ ok: true, plan: r.rows[0], mrr: await billing.mrr() });
  } catch (e) {
    console.error('[super.updatePlan]', e.message);
    res.status(500).json({ ok: false, error: 'Erro ao atualizar plano' });
  }
});

/* ------------------- comprovantes PIX (aba Pagamentos) ------------------- */
router.get('/payments', async (req, res) => {
  const status = String(req.query.status || 'pending');
  const where = status === 'all' ? '' : 'WHERE pp.status = $1';
  try {
    const r = await db.runSuper(
      `SELECT pp.id, pp.tenant_id, pp.plan, pp.amount, pp.note, pp.status,
              pp.created_by, pp.created_at, pp.decided_at,
              t.name AS tenant_name, t.subdomain, t.status AS tenant_status
       FROM payment_proofs pp
       JOIN tenants t ON t.id = pp.tenant_id
       ${where}
       ORDER BY pp.created_at DESC LIMIT 100`,
      status === 'all' ? [] : [status]
    );
    res.json({ ok: true, payments: r.rows });
  } catch (e) {
    console.error('[super.payments]', e.message);
    res.status(500).json({ ok: false, error: 'Erro ao listar pagamentos' });
  }
});

/* ------------------- leads de contratação (landing page) ------------------- */
router.get('/leads', async (req, res) => {
  const status = String(req.query.status || 'new');
  const where = status === 'all' ? '' : 'WHERE status = $1';
  try {
    const r = await db.runSuper(
      `SELECT id, plan, name, whatsapp, message, source, status, created_at
       FROM saas_leads ${where} ORDER BY created_at DESC LIMIT 100`,
      status === 'all' ? [] : [status]
    );
    res.json({ ok: true, leads: r.rows });
  } catch (e) {
    console.error('[super.leads]', e.message);
    res.status(500).json({ ok: false, error: 'Erro ao listar contatos' });
  }
});

router.put('/leads/:id', async (req, res) => {
  const id = String(req.params.id || '');
  const status = String((req.body || {}).status || '');
  if (!['new', 'contacted', 'converted', 'archived'].includes(status)) {
    return res.status(400).json({ ok: false, error: 'Status inválido' });
  }
  try {
    const r = await db.runSuper('UPDATE saas_leads SET status = $1 WHERE id = $2 RETURNING id', [status, id]);
    if (!r.rows.length) return res.status(404).json({ ok: false, error: 'Contato não encontrado' });
    audit(req, 'lead.status', null, { leadId: id, status });
    res.json({ ok: true });
  } catch (e) {
    console.error('[super.lead.update]', e.message);
    res.status(500).json({ ok: false, error: 'Erro ao atualizar contato' });
  }
});

/* ------------------- assinaturas (contratação self-service) ----------------- */
router.get('/subscriptions', async (req, res) => {
  try {
    const list = await contracting.listSubscriptions(String(req.query.status || 'awaiting_payment'));
    res.json({ ok: true, subscriptions: list });
  } catch (e) {
    console.error('[super.subscriptions]', e.message);
    res.status(500).json({ ok: false, error: 'Erro ao listar assinaturas' });
  }
});

/* Libera o acesso: ativa o plano por 30 dias e gera o código de acesso */
router.post('/subscriptions/:id/activate', async (req, res) => {
  const id = String(req.params.id || '');
  if (!uuidRe(id)) return res.status(404).json({ ok: false, error: 'Assinatura não encontrada' });
  try {
    const result = await contracting.activate(id);
    invalidateTenantCache();
    await audit(req, 'subscription_activated', result.tenantId, {
      subscription: id, plan: result.plan, accessCode: result.accessCode
    });
    // Baixa a assinatura correspondente marcada na fila de leads
    await db.runSuper(
      `UPDATE saas_leads SET status = 'converted'
        WHERE subscription_id = $1 AND status IN ('new', 'contacted')`,
      [id]
    );
    res.json({ ok: true, ...result });
  } catch (e) {
    if (e.code === 'SUBSCRIPTION_NOT_FOUND') {
      return res.status(404).json({ ok: false, error: e.message });
    }
    console.error('[super.subscription.activate]', e.message);
    res.status(500).json({ ok: false, error: 'Erro ao liberar o acesso' });
  }
});

/* Aprova: ativa a loja + 30 dias de assinatura + baixa da fila */
router.post('/payments/:id/approve', async (req, res) => {
  const id = String(req.params.id || '');
  try {
    const result = await db.withSuperTransaction(async ({ q }) => {
      const proof = await q(
        `UPDATE payment_proofs SET status = 'approved', decided_at = NOW(), decided_by = $1
         WHERE id = $2 AND status = 'pending'
         RETURNING tenant_id, plan, amount`,
        [req.user.sub, id]
      );
      if (!proof.rows.length) {
        const exists = await q('SELECT status FROM payment_proofs WHERE id = $1', [id]);
        return exists.rows.length ? { alreadyProcessed: true } : { missing: true };
      }
      const p = proof.rows[0];
      const tenant = await q(
        `UPDATE tenants SET plan = $1, status = 'active',
          subscription_expires_at = GREATEST(COALESCE(subscription_expires_at, NOW()), NOW()) + INTERVAL '30 days',
          trial_ends_at = NULL, updated_at = NOW()
         WHERE id = $2 AND deleted_at IS NULL
         RETURNING id, subdomain, slug`,
        [p.plan, p.tenant_id]
      );
      if (!tenant.rows.length) throw new Error('Loja do comprovante não encontrada ou removida');
      return { payment: p, tenant: tenant.rows[0] };
    });
    if (result.missing) return res.status(404).json({ ok: false, error: 'Comprovante não encontrado' });
    if (result.alreadyProcessed) return res.status(409).json({ ok: false, error: 'Comprovante já processado' });

    invalidateTenantCache(result.tenant.subdomain);
    invalidateTenantCache(result.tenant.slug);
    invalidateTenantCache(result.payment.tenant_id);
    await audit(req, 'payment_approved', result.payment.tenant_id, { proof: id, plan: result.payment.plan, amount: Number(result.payment.amount) });

    // Se a loja veio da contratação self-service, ativa a assinatura e gera
    // o código de acesso que o admin entrega ao cliente.
    let accessCode = '';
    const code = contracting.generateAccessCode();
    const subUpdate = await db.runSuper(
      `UPDATE subscriptions
           SET status = 'active',
               activated_at = COALESCE(activated_at, NOW()),
               renews_at = COALESCE(renews_at, NOW()) + INTERVAL '30 days',
               access_code = CASE WHEN access_code = '' THEN $1 ELSE access_code END
         WHERE tenant_id = $2 AND status <> 'active'
         RETURNING id, access_code`,
      [code, result.payment.tenant_id]
    );
    if (subUpdate.rows.length) {
      accessCode = subUpdate.rows[0].access_code || '';
      await audit(req, 'subscription_activated', result.payment.tenant_id, { subscription: subUpdate.rows[0].id, accessCode });
      await db.runSuper(
        `UPDATE saas_leads SET status = 'converted' WHERE subscription_id = $1 AND status IN ('new', 'contacted')`,
        [subUpdate.rows[0].id]
      );
    }
    res.json({ ok: true, accessCode });
  } catch (e) {
    console.error('[super.approve]', e.message);
    res.status(500).json({ ok: false, error: 'Erro ao aprovar pagamento' });
  }
});

router.post('/payments/:id/reject', async (req, res) => {
  const id = String(req.params.id || '');
  try {
    const result = await db.runSuper(
      `UPDATE payment_proofs SET status = 'rejected', decided_at = NOW(), decided_by = $1
       WHERE id = $2 AND status = 'pending' RETURNING tenant_id`,
      [req.user.sub, id]
    );
    if (!result.rows.length) {
      const exists = await db.runSuper('SELECT 1 FROM payment_proofs WHERE id = $1', [id]);
      return res.status(exists.rows.length ? 409 : 404).json({
        ok: false,
        error: exists.rows.length ? 'Comprovante já processado' : 'Comprovante não encontrado'
      });
    }
    await audit(req, 'payment_rejected', result.rows[0].tenant_id, { proof: id });
    res.json({ ok: true });
  } catch (e) {
    console.error('[super.reject]', e.message);
    res.status(500).json({ ok: false, error: 'Erro ao rejeitar pagamento' });
  }
});

/* ------------------- templates WhatsApp + PIX (aba Mensagens) ------------------- */
const MSG_KEYS = ['onboarding', 'billingReminder', 'suspensionNotice', 'reactivationNotice'];

router.get('/templates', async (req, res) => {
  try {
    const r = await db.runSuper('SELECT templates, pix_key, pix_name, support_whatsapp FROM saas_templates WHERE id = $1', ['default']);
    res.json({ ok: true, ...(r.rows[0] || { templates: {}, pix_key: '', pix_name: '', support_whatsapp: '' }) });
  } catch (e) {
    console.error('[super.templates]', e.message);
    res.status(500).json({ ok: false, error: 'Erro ao buscar modelos' });
  }
});

router.put('/templates', async (req, res) => {
  const body = req.body || {};
  try {
    const cur = await db.runSuper('SELECT templates, pix_key, pix_name, support_whatsapp FROM saas_templates WHERE id = $1', ['default']);
    const row = cur.rows[0] || { templates: {}, pix_key: '', pix_name: '', support_whatsapp: '' };
    const merged = Object.assign({}, row.templates || {});
    for (const k of MSG_KEYS) {
      if (body.templates && body.templates[k] !== undefined) merged[k] = String(body.templates[k]).slice(0, 4000);
    }
    await db.runSuper(
      `UPDATE saas_templates SET templates = $1, pix_key = $2, pix_name = $3, support_whatsapp = $4, updated_at = NOW() WHERE id = 'default'`,
      [merged,
       body.pix_key !== undefined ? String(body.pix_key).slice(0, 100) : row.pix_key,
       body.pix_name !== undefined ? String(body.pix_name).slice(0, 200) : row.pix_name,
       body.support_whatsapp !== undefined ? String(body.support_whatsapp).replace(/\D/g, '').slice(0, 20) : (row.support_whatsapp || '')]
    );
    await audit(req, 'templates_updated', null, {});
    res.json({ ok: true });
  } catch (e) {
    console.error('[super.saveTemplates]', e.message);
    res.status(500).json({ ok: false, error: 'Erro ao salvar modelos' });
  }
});

/* ------------------- redefinir senha do lojista (Modal 5) ------------------- */
router.post('/tenants/:id/password-reset', async (req, res) => {
  const id = String(req.params.id || '');
  if (!uuidRe(id)) return res.status(404).json({ ok: false, error: 'Tenant não encontrado' });
  try {
    const t = await db.runSuper('SELECT id, name, subdomain FROM tenants WHERE id = $1 AND deleted_at IS NULL', [id]);
    if (!t.rows.length) return res.status(404).json({ ok: false, error: 'Tenant não encontrado' });
    const u = await db.runSuper(
      `SELECT id, email, name FROM users WHERE tenant_id = $1 AND active AND role = 'admin' ORDER BY created_at LIMIT 1`,
      [id]
    );
    if (!u.rows.length) return res.status(404).json({ ok: false, error: 'Tenant sem admin ativo' });
    const { hashPass, generatePassword } = require('../lib/passwords');
    const nova = `${t.rows[0].subdomain}#${generatePassword(4).toUpperCase()}`;
    await db.runSuper('UPDATE users SET password_hash = $1, updated_at = NOW() WHERE id = $2', [hashPass(nova), u.rows[0].id]);
    await db.runSuper('UPDATE refresh_tokens SET revoked_at = NOW() WHERE user_id = $1 AND revoked_at IS NULL', [u.rows[0].id]);
    await audit(req, 'password_reset', id, { email: u.rows[0].email });
    res.json({ ok: true, email: u.rows[0].email, tenant: t.rows[0] });
  } catch (e) {
    console.error('[super.pwreset]', e.message);
    res.status(500).json({ ok: false, error: 'Erro ao redefinir senha' });
  }
});

/* ------------------- auditoria global (aba Auditoria) ------------------- */
router.get('/audit', async (req, res) => {
  try {
    // Sem paginação: o Super Admin vê toda a trilha de auditoria.
    const [count, list] = await Promise.all([
      db.runSuper('SELECT COUNT(*)::int AS c FROM super_admin_audit'),
      db.runSuper(
        `SELECT a.*, t.name AS tenant_name, t.subdomain
         FROM super_admin_audit a LEFT JOIN tenants t ON t.id = a.tenant_id
         ORDER BY a.created_at DESC`
      )
    ]);
    res.json({ ok: true, page: 1, perPage: count.rows[0].c || 0, total: count.rows[0].c, audit: list.rows });
  } catch (e) {
    console.error('[super.auditList]', e.message);
    res.status(500).json({ ok: false, error: 'Erro ao buscar auditoria' });
  }
});

/* Limpa a trilha de auditoria. Exige a senha do próprio Super Admin:
   é uma ação destrutiva e fica registrada em log do servidor. */
router.post('/audit/clear', async (req, res) => {
  const password = String((req.body || {}).password || '');
  if (!password) return res.status(400).json({ ok: false, error: 'Informe a senha do Super Admin' });

  const email = String(req.user.email || '').toLowerCase();
  const row = await db.runSuper(
    'SELECT id, password_hash FROM super_admins WHERE lower(email) = $1 AND active',
    [email]
  );
  if (!row.rows.length) {
    return res.status(401).json({ ok: false, error: 'Conta Super Admin não encontrada' });
  }
  if (!(await verifyPass(password, row.rows[0].password_hash))) {
    await audit(req, 'audit_clear_denied', null, { ip: req.ip });
    return res.status(401).json({ ok: false, error: 'Senha incorreta' });
  }

  const before = await db.runSuper('SELECT COUNT(*)::int AS c FROM super_admin_audit');
  const removed = before.rows[0].c;
  await db.runSuper('DELETE FROM super_admin_audit');
  // A própria limpeza fica registrada na trilha (fora da transação de delete).
  await audit(req, 'audit_cleared', null, { removed });
  console.warn(`[super.audit_clear] trilha limpa por ${email} (${removed} registros)`);
  res.json({ ok: true, removed });
});

module.exports = router;
