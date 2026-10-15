/* ============================================================
   middleware/quotas.js — Fase 9 do plano (limites por plano)

   Limite -1 = ilimitado. Bloqueia criação quando o tenant já
   atingiu o teto do plano e devolve 403 com o motivo, para o
   painel poder sugerir upgrade.
   ============================================================ */
'use strict';

const db = require('../db');
const tq = require('../db/tenantQuery');

const DISK_RESOURCES = new Set(['storage_mb']);

async function tenantLimits(tenantId) {
  const t = await db.queryApp('SELECT plan FROM tenants WHERE id = $1', [tenantId]);
  if (!t.rows.length) throw new Error('Tenant não encontrado ao consultar limites');
  const p = await db.queryApp('SELECT limits FROM plans WHERE id = $1', [t.rows[0].plan]);
  if (!p.rows.length) throw new Error(`Plano não encontrado ao consultar limites: ${t.rows[0].plan}`);
  const limits = p.rows[0].limits;
  if (!limits || typeof limits !== 'object' || Array.isArray(limits)) {
    throw new Error(`Configuração de limites inválida para o plano: ${t.rows[0].plan}`);
  }
  return limits;
}

/* checkLimit(tenantId, 'products') → { allowed, limit, current, remaining } */
async function checkLimit(tenantId, resource, currentOverride) {
  const limits = await tenantLimits(tenantId);
  const limit = limits[resource];
  if (limit === undefined || limit === null) return { allowed: true, limit: null };
  const max = Number(limit);
  if (!Number.isInteger(max) || max < -1) throw new Error(`Limite inválido para ${resource}`);
  if (max === -1 || max === 0) {
    return { allowed: true, limit: null };
  }

  const current = DISK_RESOURCES.has(resource)
    ? Number(currentOverride)
    : await tq.countTenantResource(tenantId, resource);
  if (!Number.isFinite(current) || current < 0) {
    throw new Error(`Uso atual inválido para ${resource}`);
  }
  const allowed = DISK_RESOURCES.has(resource) ? current <= max : current < max;
  if (!allowed) {
    return { allowed: false, limit: max, current, remaining: 0, upgradeUrl: '/pages/super-admin.html' };
  }
  return { allowed: true, limit: max, current, remaining: Math.max(0, max - current) };
}

function quotaHeaders(res, resource, info) {
  if (!info) return;
  if (info.limit === null || info.limit === undefined) {
    res.setHeader('X-RateLimit-Limit', 'unlimited');
    res.setHeader('X-RateLimit-Remaining', 'unlimited');
  } else {
    res.setHeader('X-RateLimit-Limit', String(info.limit));
    res.setHeader('X-RateLimit-Remaining', String(info.remaining));
  }
  res.setHeader('X-RateLimit-Resource', resource);
}

function quotaError(res, resource, info) {
  return res.status(403).json({
    ok: false,
    code: 'QUOTA_EXCEEDED',
    resource,
    limit: info.limit,
    current: info.current,
    error: `Limite do plano atingido (${resource}: ${info.current}/${info.limit}). Faça upgrade para continuar.`
  });
}

/* Middleware direto para rotas de criação (ex.: POST /api/users) */
function requireQuota(resource) {
  return async (req, res, next) => {
    try {
      const info = await checkLimit(req.tenantId, resource);
      quotaHeaders(res, resource, info);
      if (!info.allowed) return quotaError(res, resource, info);
      next();
    } catch (e) {
      next(e);
    }
  };
}

/* O painel salva o estado inteiro de uma vez; contagens de pedidos usam
   tanto o payload quanto o banco para não permitir contornar a cota omitindo
   pedidos da carga enviada. */
async function checkStateLimits(tenantId, payload) {
  const limits = await tenantLimits(tenantId);

  const violations = [];
  const counts = {
    products: Array.isArray(payload.products) ? payload.products.length : null,
    bairros: Array.isArray(payload.bairros) ? payload.bairros.length : null
  };

  for (const [resource, count] of Object.entries(counts)) {
    const limit = limits[resource];
    if (count === null || limit === undefined || limit === null) continue;
    const max = Number(limit);
    if (!Number.isInteger(max) || max < -1) throw new Error(`Limite inválido para ${resource}`);
    if (max <= 0) continue;
    if (count > max) {
      violations.push({ resource, limit: max, current: count });
    }
  }

  // pedidos: contam os últimos 30 dias do payload
  const orderLimit = limits.orders_month;
  if (orderLimit !== undefined && orderLimit !== null && Array.isArray(payload.orders)) {
    const max = Number(orderLimit);
    if (!Number.isInteger(max) || max < -1) throw new Error('Limite inválido para orders_month');
    if (max === 0 || max === -1) return violations.length ? violations : null;
    const cutoff = Date.now() - 30 * 24 * 60 * 60 * 1000;
    const recentInPayload = payload.orders.filter(o => {
      const t = Date.parse(o && o.createdAt ? o.createdAt : '');
      return Number.isFinite(t) && t >= cutoff;
    }).length;
    const recentInDatabase = await tq.countTenantResource(tenantId, 'orders_month');
    const recent = Math.max(recentInPayload, recentInDatabase);
    if (recent > max) {
      violations.push({ resource: 'orders_month', limit: max, current: recent });
    }
  }

  return violations.length ? violations : null;
}

/* Espaço em disco usado pelo tenant (MB), para storage_mb — versão async não-bloqueante */
async function tenantUsageMb(dir) {
  const fs = require('fs').promises;
  let total = 0;
  
  async function walk(p) {
    let entries;
    try { entries = await fs.readdir(p, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      const full = p + '/' + entry.name;
      if (entry.isDirectory()) {
        await walk(full);
      } else {
        try {
          const stats = await fs.stat(full);
          total += stats.size;
        } catch { /* arquivo removido entre o readdir e o stat: ignora */ }
      }
    }
  }
  
  await walk(dir);
  return Math.round((total / (1024 * 1024)) * 100) / 100;
}

module.exports = {
  checkLimit,
  requireQuota,
  quotaHeaders,
  quotaError,
  checkStateLimits,
  tenantLimits,
  tenantUsageMb
};
