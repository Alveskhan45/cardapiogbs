/* ============================================================
   db/tenantQuery.js — helpers de leitura/escrita por tenant
   (alternativa segura ao "injetar WHERE tenant_id por regex":
   cada operação é explícita e o tenant_id vem sempre da
   variável de sessão RLS + parâmetro $1, nunca de concatenação)
   ============================================================ */
'use strict';

const db = require('./index');

const ROW_TABLES = ['products', 'orders', 'coupons', 'bairros'];

/* Chaves de senha nunca ficam na tabela config (moram em users).
   Filtrar aqui impede que uma carga antiga/vinda do front as grave. */
const SECRET_CONFIG_KEYS = ['adminPasswordHash', 'adminPassword'];

function safeConfig(cfg) {
  const out = {};
  for (const [k, v] of Object.entries(cfg || {})) {
    if (SECRET_CONFIG_KEYS.includes(k)) continue;
    out[k] = v;
  }
  return out;
}

/* Lê o estado completo de um tenant (mesmo formato do objeto `db` antigo):
   { products, orders, coupons, bairros, categories, config, adminLog, stockLog } */
async function loadTenantData(tenantId) {
  const out = {};

  for (const t of ROW_TABLES) {
    const r = await db.runTenant(tenantId, 
      `SELECT data FROM ${t} WHERE tenant_id = $1`,
      [tenantId]
    );
    out[t] = r.rows.map(x => (typeof x.data === 'string' ? JSON.parse(x.data) : x.data));
  }

  const cats = await db.runTenant(tenantId, 'SELECT name FROM categories WHERE tenant_id = $1', [tenantId]);
  out.categories = cats.rows.map(r => r.name);

  const cfg = await db.runTenant(tenantId, 'SELECT key, value FROM config WHERE tenant_id = $1', [tenantId]);
  out.config = safeConfig(Object.fromEntries(cfg.rows.map(r => [r.key, r.value])));

  const aLog = await db.runTenant(tenantId, 'SELECT data FROM admin_log WHERE tenant_id = $1', [tenantId]);
  out.adminLog = aLog.rows.length ? (typeof aLog.rows[0].data === 'string' ? JSON.parse(aLog.rows[0].data) : aLog.rows[0].data) : [];

  const sLog = await db.runTenant(tenantId, 'SELECT data FROM stock_log WHERE tenant_id = $1', [tenantId]);
  out.stockLog = sLog.rows.length ? (typeof sLog.rows[0].data === 'string' ? JSON.parse(sLog.rows[0].data) : sLog.rows[0].data) : [];

  return out;
}

/* Persiste o estado completo do tenant em UMA transação:
   Upsert (INSERT ... ON CONFLICT) por tabela — mais eficiente que DELETE + INSERT
   pois preserva linhas inalteradas e evita bloat de tabelas. */
async function persistTenantData(tenantId, data) {
  await db.withTenantTransaction(tenantId, async ctx => {
    for (const t of ROW_TABLES) {
      for (const row of data[t] || []) {
        if (t === 'orders' && row.createdAt) {
          await ctx.q(
            `INSERT INTO orders (tenant_id, id, data, created_at)
             VALUES ($1, $2, $3, COALESCE(($3::jsonb->>'createdAt')::timestamptz, NOW()))
             ON CONFLICT (tenant_id, id) DO UPDATE SET
               data = EXCLUDED.data,
               created_at = EXCLUDED.created_at,
               updated_at = NOW()`,
            [tenantId, String(row.id), row]
          );
        } else {
          await ctx.q(
            `INSERT INTO ${t} (tenant_id, id, data) VALUES ($1, $2, $3)
             ON CONFLICT (tenant_id, id) DO UPDATE SET
               data = EXCLUDED.data,
               updated_at = NOW()`,
            [tenantId, String(row.id), row]
          );
        }
      }
    }

    for (const name of data.categories || []) {
      await ctx.q(
        `INSERT INTO categories (tenant_id, name) VALUES ($1, $2)
         ON CONFLICT (tenant_id, name) DO NOTHING`,
        [tenantId, String(name)]
      );
    }

    for (const [k, v] of Object.entries(safeConfig(data.config))) {
      if (v === undefined) continue;
      await ctx.q(
        `INSERT INTO config (tenant_id, key, value) VALUES ($1, $2, $3)
         ON CONFLICT (tenant_id, key) DO UPDATE SET
           value = EXCLUDED.value`,
        [tenantId, k, JSON.stringify(v)]
      );
    }

    await ctx.q(
      `INSERT INTO admin_log (tenant_id, data, updated_at) VALUES ($1, $2, NOW())
       ON CONFLICT (tenant_id) DO UPDATE SET
         data = EXCLUDED.data,
         updated_at = NOW()`,
      [tenantId, JSON.stringify(data.adminLog || [])]
    );

    await ctx.q(
      `INSERT INTO stock_log (tenant_id, data, updated_at) VALUES ($1, $2, NOW())
       ON CONFLICT (tenant_id) DO UPDATE SET
         data = EXCLUDED.data,
         updated_at = NOW()`,
      [tenantId, JSON.stringify(data.stockLog || [])]
    );
  });
}

/* Contagens para quotas e métricas (tabelas multi-tenant → pool do app). */
const COUNT_SQL = {
  products: 'SELECT COUNT(*)::int AS c FROM products WHERE tenant_id = $1',
  orders_month: "SELECT COUNT(*)::int AS c FROM orders WHERE tenant_id = $1 AND created_at >= NOW() - INTERVAL '30 days'",
  orders: 'SELECT COUNT(*)::int AS c FROM orders WHERE tenant_id = $1',
  bairros: 'SELECT COUNT(*)::int AS c FROM bairros WHERE tenant_id = $1',
  users: 'SELECT COUNT(*)::int AS c FROM users WHERE tenant_id = $1 AND active'
};

async function countTenantResource(tenantId, resource) {
  const sql = COUNT_SQL[resource];
  if (!sql) throw new Error('Recurso de quota desconhecido: ' + resource);
  const r = await db.runTenant(tenantId, sql, [tenantId]);
  return r.rows[0].c;
}

module.exports = {
  ROW_TABLES,
  loadTenantData,
  persistTenantData,
  countTenantResource,
  COUNT_SQL
};
