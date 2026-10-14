/* ============================================================
   middleware/auth.js — Fase 3 do plano

   JWT com claims { sub, tenantId, role, permissions } para
   usuário de tenant e { sub, superAdmin } para o painel da plataforma.

   Aceita o token em duas formas (compatibilidade com o front já
   existente, que manda x-token):
     Authorization: Bearer <jwt>
     x-token: <jwt>
   ============================================================ */
'use strict';

const jwt = require('jsonwebtoken');
const { v4: uuidv4 } = require('uuid');

function secret() {
  const s = process.env.JWT_SECRET;
  if (!s) throw new Error('JWT_SECRET não definido');
  return s;
}

function extractToken(req) {
  const auth = req.get('authorization') || '';
  if (auth.startsWith('Bearer ')) return auth.slice(7).trim();
  const legacy = req.get('x-token');
  return legacy ? String(legacy).trim() : '';
}

function signAccessToken(payload) {
  return jwt.sign(payload, secret(), {
    expiresIn: process.env.JWT_ACCESS_TTL || '12h',
    issuer: 'cardapio-saas',
    audience: process.env.JWT_AUDIENCE || 'cardapio-saas'
  });
}

function signSuperToken(superAdmin) {
  return jwt.sign(
    { sub: superAdmin.id, superAdmin: true, name: superAdmin.name || '', email: superAdmin.email },
    secret(),
    { expiresIn: process.env.JWT_ACCESS_TTL || '12h', issuer: 'cardapio-saas', audience: process.env.JWT_AUDIENCE || 'cardapio-saas' }
  );
}

function refreshTtlMs() {
  const raw = String(process.env.JWT_REFRESH_TTL || '30d');
  const m = /^(\d+)([smhd])$/.exec(raw.trim());
  if (!m) return 30 * 24 * 60 * 60 * 1000;
  const n = Number(m[1]);
  const unit = { s: 1000, m: 60000, h: 3600000, d: 86400000 }[m[2]];
  return n * unit;
}

/* Token de um usuário de tenant */
function issueTenantToken(user, tenantId) {
  return signAccessToken({
    sub: user.id,
    tenantId,
    role: user.role || 'admin',
    permissions: user.permissions || {},
    name: user.name || ''
  });
}

/* Token de impersonação: mesmo poder do admin do tenant, marcado
   com who = id do super-admin que pediu (auditoria). */
function issueImpersonationToken(user, tenantId, superAdminId) {
  return signAccessToken({
    sub: user.id,
    tenantId,
    role: user.role || 'admin',
    permissions: user.permissions || {},
    name: user.name || '',
    impersonated: true,
    by: superAdminId || null
  });
}

function requireAuth(req, res, next) {
  const token = extractToken(req);
  if (!token) return res.status(401).json({ ok: false, error: 'Token requerido' });

  let decoded;
  try {
    decoded = jwt.verify(token, secret(), {
      algorithms: ['HS256'],
      issuer: 'cardapio-saas',
      audience: process.env.JWT_AUDIENCE || 'cardapio-saas'
    });
  } catch (e) {
    return res.status(401).json({ ok: false, error: 'Token inválido ou expirado' });
  }

  // Painel da plataforma: passa por tudo (o tenant é opcional no header).
  if (decoded.superAdmin) {
    req.superAdmin = true;
    req.user = decoded;
    return next();
  }

  if (!req.tenantId) {
    return res.status(400).json({ ok: false, code: 'TENANT_REQUIRED', error: 'Tenant não identificado' });
  }
  if (decoded.tenantId !== req.tenantId) {
    return res.status(403).json({ ok: false, code: 'TENANT_MISMATCH', error: 'Acesso negado a este tenant' });
  }

  req.user = decoded;
  req.userId = decoded.sub;
  next();
}

function requireRole(...roles) {
  return (req, res, next) => {
    if (req.superAdmin) return next();
    if (!req.user) return res.status(401).json({ ok: false, error: 'Não autenticado' });
    if (!roles.includes(req.user.role)) {
      return res.status(403).json({ ok: false, code: 'ROLE_REQUIRED', error: 'Permissão insuficiente' });
    }
    next();
  };
}

/* requirePermission('orders','write') → permissions.orders = ['read','write'] */
function requirePermission(resource, action) {
  return (req, res, next) => {
    if (req.superAdmin) return next();
    const perms = (req.user && req.user.permissions) || {};
    const allowed = perms[resource];
    if (Array.isArray(allowed) && (allowed.includes(action) || allowed.includes('*'))) return next();
    return res.status(403).json({ ok: false, code: 'PERMISSION_REQUIRED', error: 'Permissão insuficiente' });
  };
}

function requireSuperAdmin(req, res, next) {
  if (req.superAdmin) return next();
  return res.status(403).json({ ok: false, error: 'Acesso restrito ao painel da plataforma' });
}

module.exports = {
  requireAuth,
  requireRole,
  requirePermission,
  requireSuperAdmin,
  extractToken,
  issueTenantToken,
  issueImpersonationToken,
  signSuperToken,
  signAccessToken,
  refreshTtlMs,
  uuidv4
};
