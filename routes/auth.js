/* ============================================================
   routes/auth.js — Fase 3.1/3.4 do plano

   POST /api/auth/login    { email, password }  (tenant vem do host)
   POST /api/auth/refresh  { refreshToken }
   POST /api/auth/logout   { refreshToken? }
   GET  /api/auth/me

   CRUD de usuários do tenant (requireRole('admin')):
   GET/POST /api/auth/users, PUT/DELETE /api/auth/users/:id
   ============================================================ */
'use strict';

const express = require('express');
const { v4: uuidv4 } = require('uuid');
const db = require('../db');
const { hashPass, verifyPass, passwordNeedsMigration, validatePasswordStrength } = require('../lib/passwords');
const { requireAuth, requireRole, issueTenantToken, refreshTtlMs } = require('../middleware/auth');
const quotas = require('../middleware/quotas');
const { loginLimiter, paymentProofLimiter } = require('../middleware/rateLimit');

const router = express.Router();

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const ROLES = ['admin', 'operator', 'viewer'];

function normalizeEmail(v) {
  return String(v || '').trim().toLowerCase().slice(0, 254);
}

function normalizePassword(v) {
  return String(v || '').slice(0, 256);
}

function publicUser(u) {
  return {
    id: u.id,
    email: u.email,
    name: u.name,
    role: u.role,
    permissions: u.permissions || {},
    active: u.active,
    lastLogin: u.last_login
  };
}

async function findUser(tenantId, email) {
  const r = await db.runTenant(tenantId, 
    `SELECT id, email, password_hash, name, role, permissions, active, last_login,
            failed_login_attempts, locked_until
     FROM users WHERE tenant_id = $1 AND lower(email) = lower($2) AND active`,
    [tenantId, email]
  );
  return r.rows[0] || null;
}

async function issueSession(user, tenantId) {
  const accessToken = issueTenantToken(user, tenantId);
  const jti = uuidv4();
  const expiresAt = new Date(Date.now() + refreshTtlMs());
  await db.runTenant(tenantId, 
    `INSERT INTO refresh_tokens (jti, user_id, tenant_id, expires_at)
     VALUES ($1, $2, $3, $4)`,
    [jti, user.id, tenantId, expiresAt]
  );
  await db.runTenant(tenantId, 'UPDATE users SET last_login = NOW(), updated_at = NOW() WHERE id = $1', [user.id]);
  return { token: accessToken, refreshToken: jti, expiresAt: expiresAt.toISOString() };
}

/* ------------------- login ------------------- */
router.post('/login', loginLimiter, async (req, res) => {
  if (!req.tenantId) return res.status(400).json({ ok: false, code: 'TENANT_REQUIRED', error: 'Tenant não identificado' });

  const email = normalizeEmail(req.body && req.body.email);
  const password = normalizePassword(req.body && req.body.password);
  if (!password) {
    return res.status(400).json({ ok: false, error: 'Informe a senha' });
  }
  if (email && !EMAIL_RE.test(email)) {
    return res.status(400).json({ ok: false, error: 'E-mail inválido' });
  }
  if (password.length < 8 || password.length > 128) {
    return res.status(400).json({ ok: false, error: 'Senha deve ter entre 8 e 128 caracteres' });
  }

  const MAX_FAILED_ATTEMPTS = 5;
  const LOCKOUT_DURATION_MS = 15 * 60 * 1000; // 15 minutos

  try {
    // Sem e-mail: só funciona se houver UM único admin ativo na loja.
    let user = email ? await findUser(req.tenantId, email) : null;
    if (!user && !email) {
      const todos = await db.runTenant(req.tenantId,
        'SELECT id, email, password_hash, name, role, permissions, active, failed_login_attempts, locked_until FROM users WHERE tenant_id = $1 AND active ORDER BY created_at',
        [req.tenantId]
      );
      if (todos.rows.length === 1) user = todos.rows[0];
    }
    
    // Verifica lockout
    if (user && user.locked_until && new Date(user.locked_until).getTime() > Date.now()) {
      const remainingMs = new Date(user.locked_until).getTime() - Date.now();
      const remainingMin = Math.ceil(remainingMs / 60000);
      return res.status(429).json({ 
        ok: false, 
        error: `Conta temporariamente bloqueada. Tente novamente em ${remainingMin} minuto(s).`,
        code: 'ACCOUNT_LOCKED',
        retryAfter: remainingMin * 60
      });
    }
    
    if (!user || !verifyPass(password, user.password_hash)) {
      // Incrementa tentativas falhadas se usuário existe
      if (user) {
        const newAttempts = (user.failed_login_attempts || 0) + 1;
        const updates = ['failed_login_attempts = ' + newAttempts];
        if (newAttempts >= MAX_FAILED_ATTEMPTS) {
          const lockedUntil = new Date(Date.now() + LOCKOUT_DURATION_MS).toISOString();
          updates.push('locked_until = \'' + lockedUntil + '\'');
        }
        await db.runTenant(req.tenantId, 
          `UPDATE users SET ${updates.join(', ')}, updated_at = NOW() WHERE id = $1`,
          [user.id]
        );
      }
      return res.status(401).json({ ok: false, error: 'E-mail ou senha incorretos' });
    }

    // Login bem-sucedido: reseta tentativas falhadas e lockout
    await db.runTenant(req.tenantId, 
      'UPDATE users SET failed_login_attempts = 0, locked_until = NULL, last_login = NOW(), updated_at = NOW() WHERE id = $1',
      [user.id]
    );

    // hash antigo (sha256) → aproveita o login para migrar para scrypt
    if (passwordNeedsMigration(user.password_hash)) {
      await db.runTenant(req.tenantId, 'UPDATE users SET password_hash = $1, updated_at = NOW() WHERE id = $2',
        [hashPass(password), user.id]);
    }

    const session = await issueSession(user, req.tenantId);
    res.json({
      ok: true,
      ...session,
      user: publicUser(user),
      tenant: { id: req.tenant.id, name: req.tenant.name, subdomain: req.tenant.subdomain, plan: req.tenant.plan }
    });
  } catch (e) {
    console.error('[auth.login]', e.message);
    res.status(500).json({ ok: false, error: 'Erro ao autenticar' });
  }
});

/* ------------------- refresh (rotação) ------------------- */
router.post('/refresh', async (req, res) => {
  if (!req.tenantId) return res.status(400).json({ ok: false, code: 'TENANT_REQUIRED', error: 'Tenant não identificado' });
  const jti = String((req.body && req.body.refreshToken) || '').trim();
  if (!jti) return res.status(400).json({ ok: false, error: 'refreshToken obrigatório' });

  try {
    const r = await db.runTenant(req.tenantId, 
      `SELECT rt.jti, rt.user_id, rt.revoked_at, rt.expires_at,
              u.email, u.name, u.role, u.permissions, u.active
       FROM refresh_tokens rt
       JOIN users u ON u.id = rt.user_id
       WHERE rt.jti = $1 AND rt.tenant_id = $2`,
      [jti, req.tenantId]
    );
    const rec = r.rows[0];
    if (!rec || rec.revoked_at || new Date(rec.expires_at).getTime() < Date.now() || !rec.active) {
      return res.status(401).json({ ok: false, error: 'Sessão expirada. Faça login novamente.' });
    }

    const user = { id: rec.user_id, email: rec.email, name: rec.name, role: rec.role, permissions: rec.permissions };
    const session = await issueSession(user, req.tenantId);

    // rotação: o token usado é revogado e aponta para o novo
    await db.runTenant(req.tenantId, 
      'UPDATE refresh_tokens SET revoked_at = NOW(), replaced_by = $1 WHERE jti = $2',
      [session.refreshToken, jti]
    );

    res.json({ ok: true, ...session, user: publicUser({ ...user, active: true }) });
  } catch (e) {
    console.error('[auth.refresh]', e.message);
    res.status(500).json({ ok: false, error: 'Erro ao renovar sessão' });
  }
});

/* ------------------- logout ------------------- */
router.post('/logout', async (req, res) => {
  const jti = String((req.body && req.body.refreshToken) || '').trim();
  if (jti && req.tenantId) {
    try {
      await db.runTenant(req.tenantId, 'UPDATE refresh_tokens SET revoked_at = NOW() WHERE jti = $1 AND tenant_id = $2', [jti, req.tenantId]);
    } catch (e) { /* revogar é melhor-esforço: o access token expira sozinho */ }
  }
  res.json({ ok: true });
});

/* ------------------- informar pagamento da assinatura -------------------
   O lojista avisa que pagou o plano via PIX; o super-admin confere na
   aba Pagamentos e libera a loja em 1 toque. */
router.post('/payment-proof', requireAuth, paymentProofLimiter, async (req, res) => {
  if (req.superAdmin) return res.status(400).json({ ok: false, error: 'Use o painel da plataforma' });
  if (req.user.role !== 'admin') return res.status(403).json({ ok: false, code: 'ROLE_REQUIRED', error: 'Somente um administrador da loja pode informar pagamento' });
  const body = req.body || {};
  const plan = String(body.plan || '').trim();
  const note = String(body.note || '').slice(0, 500);
  if (!['starter', 'pro'].includes(plan)) {
    return res.status(400).json({ ok: false, error: 'Selecione um plano pago válido' });
  }

  try {
    const r = await db.withSuperTransaction(async ({ q }) => {
      const tenant = await q('SELECT id FROM tenants WHERE id = $1 AND deleted_at IS NULL FOR UPDATE', [req.tenantId]);
      if (!tenant.rows.length) return { error: 'Loja não encontrada' };

      const selectedPlan = await q('SELECT id, price_monthly FROM plans WHERE id = $1', [plan]);
      if (!selectedPlan.rows.length) return { error: 'Plano não encontrado' };
      const amount = Number(selectedPlan.rows[0].price_monthly);
      if (!Number.isFinite(amount) || amount <= 0) return { error: 'O plano selecionado não possui cobrança configurada' };

      const pending = await q(
        "SELECT 1 FROM payment_proofs WHERE tenant_id = $1 AND status = 'pending' LIMIT 1",
        [req.tenantId]
      );
      if (pending.rows.length) return { conflict: true };

      const proof = await q(
        `INSERT INTO payment_proofs (tenant_id, plan, amount, note, status, created_by)
         VALUES ($1, $2, $3, $4, 'pending', $5) RETURNING id, plan, amount, created_at`,
        [req.tenantId, plan, amount, note, (req.user && req.user.name) || '']
      );
      return { proof: proof.rows[0] };
    });
    if (r.error) return res.status(404).json({ ok: false, error: r.error });
    if (r.conflict) return res.status(409).json({ ok: false, code: 'PAYMENT_PENDING', error: 'Já existe um pagamento aguardando análise' });
    res.status(201).json({ ok: true, proof: r.proof });
  } catch (e) {
    console.error('[auth.paymentProof]', e.message);
    res.status(500).json({ ok: false, error: 'Erro ao registrar pagamento' });
  }
});

/* ------------------- quem sou eu ------------------- */
router.get('/me', requireAuth, async (req, res) => {
  if (req.superAdmin) {
    return res.json({
      ok: true,
      superAdmin: true,
      user: { id: req.user.sub, name: req.user.name, email: req.user.email },
      tenant: null
    });
  }
  try {
    const r = await db.runTenant(req.tenantId, 
      'SELECT id, email, name, role, permissions, active, last_login FROM users WHERE id = $1 AND active',
      [req.user.sub]
    );
    if (!r.rows.length) return res.status(401).json({ ok: false, error: 'Usuário não encontrado ou inativo' });
    res.json({
      ok: true,
      user: publicUser(r.rows[0]),
      tenant: { id: req.tenant.id, name: req.tenant.name, subdomain: req.tenant.subdomain, plan: req.tenant.plan, status: req.tenant.status },
      impersonated: !!req.user.impersonated
    });
  } catch (e) {
    console.error('[auth.me]', e.message);
    res.status(500).json({ ok: false, error: 'Erro ao buscar usuário' });
  }
});

/* ------------------- usuários do tenant ------------------- */
router.get('/users', requireAuth, requireRole('admin'), async (req, res) => {
  if (req.superAdmin) return res.status(400).json({ ok: false, error: 'Use o painel da plataforma' });
  const r = await db.runTenant(req.tenantId, 
    `SELECT id, email, name, role, permissions, active, last_login, created_at
     FROM users WHERE tenant_id = $1 ORDER BY created_at`,
    [req.tenantId]
  );
  const info = await quotas.checkLimit(req.tenantId, 'users');
  quotas.quotaHeaders(res, 'users', info);
  res.json({ ok: true, users: r.rows.map(publicUser), quota: info });
});

router.post('/users', requireAuth, requireRole('admin'), quotas.requireQuota('users'), async (req, res) => {
  const email = String((req.body && req.body.email) || '').trim().toLowerCase();
  const name = String((req.body && req.body.name) || '').trim();
  const role = ROLES.includes((req.body || {}).role) ? req.body.role : 'operator';
  const password = String((req.body && req.body.password) || '');

  if (!EMAIL_RE.test(email)) return res.status(400).json({ ok: false, error: 'E-mail inválido' });
  const pwdCheck = validatePasswordStrength(password);
  if (!pwdCheck.valid) return res.status(400).json({ ok: false, error: 'Senha fraca: ' + pwdCheck.errors.join(', ') });

  try {
    const exists = await db.runTenant(req.tenantId, 'SELECT 1 FROM users WHERE tenant_id = $1 AND lower(email) = lower($2)', [req.tenantId, email]);
    if (exists.rows.length) return res.status(409).json({ ok: false, error: 'Já existe usuário com este e-mail' });

    const id = uuidv4();
    await db.runTenant(req.tenantId, 
      `INSERT INTO users (id, tenant_id, email, password_hash, name, role, active)
       VALUES ($1, $2, $3, $4, $5, $6, TRUE)`,
      [id, req.tenantId, email, hashPass(password), name, role]
    );
    res.status(201).json({ ok: true, user: { id, email, name, role, active: true } });
  } catch (e) {
    console.error('[auth.createUser]', e.message);
    res.status(500).json({ ok: false, error: 'Erro ao criar usuário' });
  }
});

router.put('/users/:id', requireAuth, requireRole('admin'), async (req, res) => {
  const id = String(req.params.id || '');
  const body = req.body || {};
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return res.status(400).json({ ok: false, error: 'Dados de usuário inválidos' });
  }
  if (body.role !== undefined && !ROLES.includes(body.role)) {
    return res.status(400).json({ ok: false, error: 'Função inválida' });
  }
  if (body.active !== undefined && typeof body.active !== 'boolean') {
    return res.status(400).json({ ok: false, error: 'Status de usuário inválido' });
  }
  if (body.name !== undefined && (typeof body.name !== 'string' || body.name.trim().length > 200)) {
    return res.status(400).json({ ok: false, error: 'Nome inválido (máximo 200 caracteres)' });
  }
  if (body.password !== undefined) {
    if (typeof body.password !== 'string' || body.password.length > 128) {
      return res.status(400).json({ ok: false, error: 'Senha inválida (máx. 128 caracteres)' });
    }
    const pwdCheck = validatePasswordStrength(body.password);
    if (!pwdCheck.valid) return res.status(400).json({ ok: false, error: 'Senha fraca: ' + pwdCheck.errors.join(', ') });
  }

  try {
    const result = await db.withTenantTransaction(req.tenantId, async ({ q }) => {
      const users = await q(
        'SELECT id, role, active FROM users WHERE tenant_id = $1 ORDER BY id FOR UPDATE',
        [req.tenantId]
      );
      const current = users.rows.find(user => user.id === id);
      if (!current) return { missing: true };

      const role = body.role !== undefined ? body.role : current.role;
      const active = body.active !== undefined ? body.active : current.active;
      const name = body.name !== undefined ? body.name.trim() : null;

      // Serialize user changes for this tenant before enforcing the last-admin invariant.
      const losesAdmin = current.role === 'admin' && current.active && (role !== 'admin' || !active);
      if (losesAdmin && !users.rows.some(user => user.id !== id && user.role === 'admin' && user.active)) {
        return { lastAdmin: true };
      }

      await q(
        `UPDATE users
         SET role = $1, active = $2, name = COALESCE($3, name),
             password_hash = COALESCE($4, password_hash), updated_at = NOW()
         WHERE id = $5 AND tenant_id = $6`,
        [role, active, name, body.password !== undefined ? hashPass(body.password) : null, id, req.tenantId]
      );

      if (body.password !== undefined) {
        // senha trocada: derruba sessões abertas deste usuário
        await q('UPDATE refresh_tokens SET revoked_at = NOW() WHERE user_id = $1 AND tenant_id = $2 AND revoked_at IS NULL', [id, req.tenantId]);
      }

      return { updated: true };
    });
    if (result.missing) return res.status(404).json({ ok: false, error: 'Usuário não encontrado' });
    if (result.lastAdmin) return res.status(400).json({ ok: false, error: 'O tenant precisa de ao menos um admin ativo' });
    res.json({ ok: true });
  } catch (e) {
    console.error('[auth.updateUser]', e.message);
    res.status(500).json({ ok: false, error: 'Erro ao atualizar usuário' });
  }
});

router.delete('/users/:id', requireAuth, requireRole('admin'), async (req, res) => {
  const id = String(req.params.id || '');
  if (id === req.user.sub) return res.status(400).json({ ok: false, error: 'Você não pode remover o próprio usuário' });

  try {
    const current = await db.runTenant(req.tenantId, 'SELECT id, role, active FROM users WHERE id = $1 AND tenant_id = $2', [id, req.tenantId]);
    if (!current.rows.length) return res.status(404).json({ ok: false, error: 'Usuário não encontrado' });

    if (current.rows[0].role === 'admin' && current.rows[0].active) {
      const others = await db.runTenant(req.tenantId, 
        `SELECT COUNT(*)::int AS c FROM users WHERE tenant_id = $1 AND active AND role = 'admin' AND id <> $2`,
        [req.tenantId, id]
      );
      if (!others.rows[0].c) return res.status(400).json({ ok: false, error: 'O tenant precisa de ao menos um admin ativo' });
    }

    await db.runTenant(req.tenantId, 'DELETE FROM users WHERE id = $1 AND tenant_id = $2', [id, req.tenantId]);
    res.json({ ok: true });
  } catch (e) {
    console.error('[auth.deleteUser]', e.message);
    res.status(500).json({ ok: false, error: 'Erro ao remover usuário' });
  }
});

module.exports = router;
