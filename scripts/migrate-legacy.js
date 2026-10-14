/* ============================================================
   scripts/migrate-legacy.js — Fase 10 do plano

   Migra a loja single-tenant (data/db.sqlite) para o Postgres
   multi-tenant, criando o tenant "legado" (subdomínio legado,
   plano enterprise) e o usuário admin correspondente.

   O hash de senha atual (scrypt/sha256) é copiado como está: quem
   usava a senha do painel antigo continua entrando sem trocar nada.

   Uso:
     node scripts/migrate-legacy.js              # migra
     node scripts/migrate-legacy.js --dry-run    # só mostra o que faria
   ============================================================ */
'use strict';

const fs = require('fs');
const path = require('path');
const { v4: uuidv4 } = require('uuid');
const Database = require('better-sqlite3');

try { process.loadEnvFile && process.loadEnvFile(); } catch (e) { /* opcional */ }

const db = require('../db');
const { hashPass, generatePassword } = require('../lib/passwords');
const { defaultConfig } = require('../lib/seed');

const ROOT = path.join(__dirname, '..');
const LEGACY_SQLITE = path.join(ROOT, 'data', 'db.sqlite');
const LEGACY_UPLOADS = path.join(ROOT, 'assets', 'uploads');

const TENANT_SUBDOMAIN = String(process.env.LEGACY_TENANT || 'legado').trim().toLowerCase();
const LEGACY_NAME = String(process.env.LEGACY_NAME || 'Cliente Legado').trim();
const ADMIN_EMAIL = String(process.env.LEGACY_ADMIN_EMAIL || 'admin@legado.com').trim().toLowerCase();
const ADMIN_NAME = String(process.env.LEGACY_ADMIN_NAME || 'Admin').trim();

const dryRun = process.argv.includes('--dry-run');

function readLegacy() {
  if (!fs.existsSync(LEGACY_SQLITE)) {
    throw new Error('Banco legado não encontrado: ' + LEGACY_SQLITE + ' (nada para migrar)');
  }
  const legacy = new Database(LEGACY_SQLITE, { readonly: true });

  const cfgRows = legacy.prepare('SELECT key, value FROM config').all();
  const config = {};
  for (const r of cfgRows) {
    try { config[r.key] = JSON.parse(r.value); } catch (e) { config[r.key] = r.value; }
  }

  const data = {
    config,
    categories: legacy.prepare('SELECT name FROM categories').all().map(r => r.name),
    products: legacy.prepare('SELECT id, data FROM products').all().map(r => JSON.parse(r.data)),
    orders: legacy.prepare('SELECT id, data FROM orders').all().map(r => JSON.parse(r.data)),
    coupons: legacy.prepare('SELECT id, data FROM coupons').all().map(r => JSON.parse(r.data)),
    bairros: legacy.prepare('SELECT id, data FROM bairros').all().map(r => JSON.parse(r.data)),
    adminLog: legacy.prepare('SELECT data FROM adminLog ORDER BY rowid').all().map(r => JSON.parse(r.data)),
    stockLog: legacy.prepare('SELECT data FROM stockLog ORDER BY rowid').all().map(r => JSON.parse(r.data))
  };

  legacy.close();
  return data;
}

/* Reaproveita os uploads antigos dentro da pasta do novo tenant */
function moveAssets(tenantId) {
  const targetDir = path.join(ROOT, 'data', 'tenants', tenantId, 'produtos');
  fs.mkdirSync(targetDir, { recursive: true });

  const moved = [];
  if (!fs.existsSync(LEGACY_UPLOADS)) return moved;

  for (const file of fs.readdirSync(LEGACY_UPLOADS)) {
    if (!/^[A-Za-z0-9._-]+$/.test(file)) continue;
    fs.copyFileSync(path.join(LEGACY_UPLOADS, file), path.join(targetDir, file));
    moved.push(file);
  }
  return moved;
}

/* Reescreve /assets/uploads/x.png → /assets/tenants/{id}/produtos/x.png */
function rewriteAssetUrls(data, tenantId) {
  const from = '/assets/uploads/';
  const to = `/assets/tenants/${tenantId}/produtos/`;
  let count = 0;

  const walk = value => {
    if (typeof value === 'string' && value.includes(from)) {
      count++;
      return value.split(from).join(to);
    }
    if (Array.isArray(value)) return value.map(walk);
    if (value && typeof value === 'object') {
      for (const k of Object.keys(value)) value[k] = walk(value[k]);
      return value;
    }
    return value;
  };

  walk(data.products);
  walk(data.config);
  return count;
}

async function main() {
  const data = readLegacy();
  const counts = {
    products: data.products.length,
    orders: data.orders.length,
    coupons: data.coupons.length,
    bairros: data.bairros.length,
    categories: data.categories.length,
    adminLog: data.adminLog.length,
    stockLog: data.stockLog.length,
    config: Object.keys(data.config).length
  };

  console.log('=== Migração do banco legado (SQLite → PostgreSQL) ===');
  console.log('Origem:', LEGACY_SQLITE);
  console.table(counts);

  if (dryRun) {
    console.log('[dry-run] nada foi gravado.');
    return;
  }

  const existing = await db.runSuper('SELECT id FROM tenants WHERE subdomain = $1 OR slug = $1', [TENANT_SUBDOMAIN]);
  if (existing.rows.length) {
    throw new Error(
      'O tenant "' + TENANT_SUBDOMAIN + '" já existe. Nada foi migrado (apague-o pelo painel ou use outro LEGACY_TENANT).'
    );
  }

  const tenantId = uuidv4();
  const oldHash = data.config.adminPasswordHash || '';
  const adminPassword = oldHash ? '(mantida a senha atual)' : generatePassword(14);
  const passwordHash = oldHash || hashPass(adminPassword);

  const moved = moveAssets(tenantId);
  const rewritten = rewriteAssetUrls(data, tenantId);

  await db.withSuperTransaction(async ctx => {
    await ctx.q(
      `INSERT INTO tenants (id, name, subdomain, slug, plan, status, settings)
       VALUES ($1, $2, $3, $3, 'enterprise', 'active', $4)`,
      [tenantId, data.config.storeName || LEGACY_NAME, TENANT_SUBDOMAIN, { migratedFrom: 'sqlite', migratedAt: new Date().toISOString() }]
    );

    await ctx.q(
      `INSERT INTO users (id, tenant_id, email, password_hash, name, role, active)
       VALUES ($1, $2, $3, $4, $5, 'admin', TRUE)`,
      [uuidv4(), tenantId, ADMIN_EMAIL, passwordHash, ADMIN_NAME]
    );

    const cfg = Object.assign({}, defaultConfig({ storeName: data.config.storeName || LEGACY_NAME }), data.config);
    delete cfg.adminPasswordHash;
    delete cfg.adminPassword;
    for (const [key, value] of Object.entries(cfg)) {
      if (value === undefined) continue;
      await ctx.q('INSERT INTO config (tenant_id, key, value) VALUES ($1, $2, $3)', [tenantId, key, JSON.stringify(value)]);
    }

    for (const p of data.products) {
      await ctx.q('INSERT INTO products (tenant_id, id, data) VALUES ($1, $2, $3)', [tenantId, String(p.id), p]);
    }
    for (const c of data.coupons) {
      await ctx.q('INSERT INTO coupons (tenant_id, id, data) VALUES ($1, $2, $3)', [tenantId, String(c.id), c]);
    }
    for (const b of data.bairros) {
      await ctx.q('INSERT INTO bairros (tenant_id, id, data) VALUES ($1, $2, $3)', [tenantId, String(b.id), b]);
    }
    for (const name of data.categories) {
      await ctx.q('INSERT INTO categories (tenant_id, name) VALUES ($1, $2)', [tenantId, String(name)]);
    }
    for (const o of data.orders) {
      await ctx.q(
        `INSERT INTO orders (tenant_id, id, data, created_at)
         VALUES ($1, $2, $3, COALESCE(($3::jsonb->>'createdAt')::timestamptz, NOW()))`,
        [tenantId, String(o.id), o]
      );
    }
    await ctx.q('INSERT INTO admin_log (tenant_id, data, updated_at) VALUES ($1, $2, NOW())', [tenantId, JSON.stringify(data.adminLog)]);
    await ctx.q('INSERT INTO stock_log (tenant_id, data, updated_at) VALUES ($1, $2, NOW())', [tenantId, JSON.stringify(data.stockLog)]);
  });

  // validação (Fase 10.2)
  const check = async (label, sql) => {
    const r = await db.runTenant(tenantId, sql, [tenantId]);
    return `${label}: ${r.rows[0].c}`;
  };

  console.log('');
  console.log('=== Validação ===');
  console.log(await check('produtos', 'SELECT COUNT(*)::int c FROM products WHERE tenant_id = $1'));
  console.log(await check('pedidos', 'SELECT COUNT(*)::int c FROM orders WHERE tenant_id = $1'));
  console.log(await check('cupons', 'SELECT COUNT(*)::int c FROM coupons WHERE tenant_id = $1'));
  console.log(await check('bairros', 'SELECT COUNT(*)::int c FROM bairros WHERE tenant_id = $1'));
  console.log(await check('categorias', 'SELECT COUNT(*)::int c FROM categories WHERE tenant_id = $1'));
  console.log(await check('itens de config', 'SELECT COUNT(*)::int c FROM config WHERE tenant_id = $1'));
  console.log(await check('usuarios', 'SELECT COUNT(*)::int c FROM users WHERE tenant_id = $1'));

  console.log('');
  console.log('=== Pronto ===');
  console.log('Tenant:', TENANT_SUBDOMAIN, '(' + tenantId + ')');
  console.log('E-mail do admin:', ADMIN_EMAIL);
  console.log('Senha:', adminPassword);
  console.log('Assets copiados:', moved.length, '| URLs reescritas:', rewritten);
  console.log('Cardápio:  http://localhost:' + (process.env.PORT || 3001) + '/?tenant=' + TENANT_SUBDOMAIN);
  if (!oldHash) {
    console.log('ATENÇÃO: o banco legado não tinha senha de painel; a senha acima é nova.');
  }
}

main()
  .then(async () => { await db.close(); process.exit(0); })
  .catch(async e => {
    console.error('');
    console.error('FALHA:', e.message);
    await db.close().catch(() => {});
    process.exit(1);
  });
