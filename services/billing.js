/* ============================================================
   services/billing.js — planos, MRR e métricas da plataforma
   (Fase 6.1 /api/super-admin/stats e /revenue)

   Tudo aqui roda no pool super-admin (BYPASSRLS) porque são
   consultas que atravessam todos os tenants.
   ============================================================ */
'use strict';

const db = require('../db');

async function listPlans() {
  const r = await db.runSuper(
    'SELECT id, name, price_monthly, limits, features FROM plans ORDER BY price_monthly'
  );
  return r.rows.map(p => ({
    id: p.id,
    name: p.name,
    priceMonthly: Number(p.price_monthly),
    limits: p.limits,
    features: p.features
  }));
}

/* Planos que geram receita: todo plano com preço > 0 (free/trial não entram) */
const PAID_PLANS = ['starter', 'pro'];

/* MRR estimado = soma do preço mensal dos tenants ATIVOS em plano pago */
async function mrr() {
  const r = await db.runSuper(`
    SELECT COALESCE(SUM(p.price_monthly), 0) AS total
    FROM tenants t JOIN plans p ON p.id = t.plan
    WHERE t.status = 'active' AND t.deleted_at IS NULL
      AND (t.subscription_expires_at IS NULL OR t.subscription_expires_at > NOW())
      AND p.price_monthly > 0
  `);
  return Number(r.rows[0].total);
}

async function platformStats() {
  const [tenants, byPlan, byStatus, orders, orders30d, users, pending, leads] = await Promise.all([
    db.runSuper(`
      SELECT
        COUNT(*)::int AS total,
        COUNT(*) FILTER (WHERE t.status = 'active' AND t.deleted_at IS NULL
          AND (t.subscription_expires_at IS NULL OR t.subscription_expires_at > NOW()))::int AS active,
        COUNT(*) FILTER (WHERE t.status = 'trial' AND t.deleted_at IS NULL)::int AS trial,
        COUNT(*) FILTER (WHERE t.status = 'suspended')::int AS suspended,
        COUNT(*) FILTER (WHERE t.status = 'cancelled' OR t.deleted_at IS NOT NULL)::int AS cancelled,
        COUNT(*) FILTER (WHERE t.status = 'active' AND t.deleted_at IS NULL
          AND (t.subscription_expires_at IS NULL OR t.subscription_expires_at > NOW())
          AND p.price_monthly > 0)::int AS paid
      FROM tenants t LEFT JOIN plans p ON p.id = t.plan
    `),
    db.runSuper(`
      SELECT t.plan, COUNT(*)::int AS c
      FROM tenants t WHERE t.deleted_at IS NULL
      GROUP BY t.plan ORDER BY c DESC
    `),
    db.runSuper(`
      SELECT status, COUNT(*)::int AS c FROM tenants GROUP BY status
    `),
    db.runSuper('SELECT COUNT(*)::int AS c, COALESCE(SUM((data->>\'total\')::numeric),0) AS revenue FROM orders'),
    db.runSuper("SELECT COUNT(*)::int AS c, COALESCE(SUM((data->>'total')::numeric),0) AS revenue FROM orders WHERE created_at >= NOW() - INTERVAL '30 days'"),
    db.runSuper('SELECT COUNT(*)::int AS c FROM users WHERE active'),
    db.runSuper("SELECT COUNT(*)::int AS c FROM payment_proofs WHERE status = 'pending'"),
    db.runSuper("SELECT COUNT(*)::int AS c FROM saas_leads WHERE status = 'new'")
  ]);

  const totalMrr = await mrr();
  return {
    tenants: tenants.rows[0],
    tenantsByPlan: byPlan.rows,
    tenantsByStatus: byStatus.rows,
    orders: { total: orders.rows[0].c, revenue: Number(orders.rows[0].revenue) },
    gmv: Number(orders.rows[0].revenue),
    last30Days: { orders: orders30d.rows[0].c, revenue: Number(orders30d.rows[0].revenue) },
    users: { active: users.rows[0].c },
    pendingPayments: pending.rows[0].c,
    newLeads: leads.rows[0].c,
    mrr: totalMrr,
    arr: totalMrr * 12
  };
}

/* Faturamento por tenant (MRR potencial de cada loja ativa) */
async function revenueByTenant() {
  const r = await db.runSuper(`
    SELECT t.id, t.name, t.subdomain, t.status, t.plan, t.created_at,
           t.cnpj, t.phone, t.address, t.primary_color,
           t.trial_ends_at, t.subscription_expires_at,
           p.price_monthly,
           COALESCE(agg.orders_30d, 0) AS orders_30d,
           COALESCE(agg.revenue_30d, 0) AS revenue_30d,
           COALESCE(prod.products, 0) AS products
    FROM tenants t
    LEFT JOIN plans p ON p.id = t.plan
    LEFT JOIN LATERAL (
      SELECT COUNT(*) AS orders_30d, COALESCE(SUM((o.data->>'total')::numeric),0) AS revenue_30d
      FROM orders o
      WHERE o.tenant_id = t.id AND o.created_at >= NOW() - INTERVAL '30 days'
    ) agg ON TRUE
    LEFT JOIN LATERAL (
      SELECT COUNT(*) AS products FROM products pr WHERE pr.tenant_id = t.id
    ) prod ON TRUE
    WHERE t.deleted_at IS NULL
    ORDER BY t.created_at DESC
  `);

  return r.rows.map(x => ({
    id: x.id,
    name: x.name,
    subdomain: x.subdomain,
    status: x.status,
    plan: x.plan,
    priceMonthly: Number(x.price_monthly || 0),
    orders30d: x.orders_30d,
    revenue30d: Number(x.revenue_30d),
    products: x.products,
    createdAt: x.created_at,
    cnpj: x.cnpj || '',
    phone: x.phone || '',
    address: x.address || '',
    primaryColor: x.primary_color || '',
    trialEndsAt: x.trial_ends_at,
    subscriptionExpiresAt: x.subscription_expires_at
  }));
}

/* Distribuição de receita por plano (aba Receita) */
async function revenueByPlan() {
  const r = await db.runSuper(`
    SELECT p.id AS plan, p.name, p.price_monthly,
           COUNT(t.id)::int AS tenants,
           COALESCE(SUM(CASE WHEN t.status = 'active' AND t.deleted_at IS NULL
             AND (t.subscription_expires_at IS NULL OR t.subscription_expires_at > NOW())
             THEN p.price_monthly ELSE 0 END), 0) AS mrr
    FROM plans p
    LEFT JOIN tenants t ON t.plan = p.id AND t.deleted_at IS NULL
    GROUP BY p.id, p.name, p.price_monthly
    ORDER BY p.price_monthly
  `);
  return r.rows.map(x => ({
    plan: x.plan, name: x.name,
    priceMonthly: Number(x.price_monthly || 0),
    tenants: x.tenants, mrr: Number(x.mrr || 0)
  }));
}

module.exports = { listPlans, mrr, platformStats, revenueByTenant, revenueByPlan, PAID_PLANS };
