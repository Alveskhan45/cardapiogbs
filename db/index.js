/* ============================================================
   Camada de dados multi-tenant (PostgreSQL)

   Dois pools:
   - appPool    → papel cardapio_app: SUJEITO a RLS. Toda query de
                  tabela multi-tenant deve passar por runTenant /
                  withTenantTransaction, que definem
                  `app.current_tenant_id` na transação (SET LOCAL).
                  Query direta sem a variável retorna VAZIO (RLS) —
                  é a defesa contra esquecimento de WHERE tenant_id.
   - superPool  → papel cardapio_admin: BYPASSRLS. Usado SÓ pelo
                  painel da plataforma (provisioning, métricas globais).
   ============================================================ */
'use strict';

const { Pool } = require('pg');

try { process.loadEnvFile && process.loadEnvFile(); } catch (e) { /* .env é opcional */ }

const DATABASE_URL = process.env.DATABASE_URL;
const SUPER_ADMIN_DATABASE_URL = process.env.SUPER_ADMIN_DATABASE_URL || DATABASE_URL;

if (!DATABASE_URL) {
  console.error('[db] DATABASE_URL não definida. Copie .env.example para .env e ajuste.');
}

const appPool = new Pool({ connectionString: DATABASE_URL, max: 20, application_name: 'cardapio_app' });
const superPool = new Pool({ connectionString: SUPER_ADMIN_DATABASE_URL, max: 10, application_name: 'cardapio_admin' });

// Prepared statement cache
const preparedStatements = new Map();

function getPreparedStatementName(sql) {
  return 'ps_' + require('crypto').createHash('md5').update(sql).digest('hex').slice(0, 16);
}

async function prepareStatement(pool, sql) {
  const name = getPreparedStatementName(sql);
  if (preparedStatements.has(name)) return name;
  
  await pool.query({ name, text: sql });
  preparedStatements.set(name, true);
  return name;
}

async function executePrepared(pool, sql, params) {
  const name = await prepareStatement(pool, sql);
  return pool.query({ name, text: sql, values: params });
}

appPool.on('error', e => console.error('[db] erro no pool do app:', e.message));
superPool.on('error', e => console.error('[db] erro no pool super:', e.message));

async function withConnection(pool, fn) {
  const client = await pool.connect();
  try {
    return await fn(client);
  } finally {
    client.release();
  }
}

/* Query simples no pool do app, SEM tenant definido (tabelas globais:
   tenants, plans; ou health-check). Com RLS ativo, query em tabela
   multi-tenant sem a variável retorna 0 linhas — comportamento correto. */
function queryApp(sql, params) {
  return withConnection(appPool, c => c.query(sql, params));
}

/* Versão com prepared statement para queries frequentes */
async function queryAppPrepared(sql, params) {
  return withConnection(appPool, async c => {
    const name = await prepareStatement(appPool, sql);
    return c.query({ name, text: sql, values: params });
  });
}

/* Query em tabela multi-tenant: transação com app.current_tenant_id definido
   (RLS aplica). ATENÇÃO: SET LOCAL não aceita parâmetros no Postgres (é statement
   de utilitário) — por isso usamos set_config(..., true), que é equivalente a
   SET LOCAL e aceita parâmetro. */
async function runTenant(tenantId, sql, params) {
  return withConnection(appPool, async c => {
    try {
      await c.query('BEGIN');
      await c.query("SELECT set_config('app.current_tenant_id', $1, true)", [tenantId]);
      const r = await c.query(sql, params);
      await c.query('COMMIT');
      return r;
    } catch (e) {
      await c.query('ROLLBACK').catch(() => {});
      throw e;
    }
  });
}

/* Versão com prepared statement para queries frequentes em tenant */
async function runTenantPrepared(tenantId, sql, params) {
  return withConnection(appPool, async c => {
    try {
      await c.query('BEGIN');
      await c.query("SELECT set_config('app.current_tenant_id', $1, true)", [tenantId]);
      const name = await prepareStatement(appPool, sql);
      const r = await c.query({ name, text: sql, values: params });
      await c.query('COMMIT');
      return r;
    } catch (e) {
      await c.query('ROLLBACK').catch(() => {});
      throw e;
    }
  });
}

/* Transação multi-tenant (persistência inteira do estado do tenant).
   fn recebe { q: (sql, params) => Promise } e roda todo dentro do BEGIN/COMMIT
   com a variável de tenant definida. */
async function withTenantTransaction(tenantId, fn) {
  return withConnection(appPool, async c => {
    try {
      await c.query('BEGIN');
      await c.query("SELECT set_config('app.current_tenant_id', $1, true)", [tenantId]);
      const out = await fn({ q: (sql, params) => c.query(sql, params) });
      await c.query('COMMIT');
      return out;
    } catch (e) {
      await c.query('ROLLBACK').catch(() => {});
      throw e;
    }
  });
}

/* Query no pool super-admin (BYPASSRLS): painel da plataforma. */
function runSuper(sql, params) {
  return withConnection(superPool, c => c.query(sql, params));
}

/* Versão com prepared statement para queries frequentes no super-admin */
async function runSuperPrepared(sql, params) {
  return withConnection(superPool, async c => {
    const name = await prepareStatement(superPool, sql);
    return c.query({ name, text: sql, values: params });
  });
}

async function withSuperTransaction(fn) {
  return withConnection(superPool, async c => {
    await c.query('BEGIN');
    try {
      const out = await fn({ q: (sql, params) => c.query(sql, params) });
      await c.query('COMMIT');
      return out;
    } catch (e) {
      await c.query('ROLLBACK').catch(() => {});
      throw e;
    }
  });
}

async function ping() {
  await appPool.query('SELECT 1');
  await superPool.query('SELECT 1');
}

async function close() {
  await appPool.end();
  await superPool.end();
}

module.exports = {
  appPool,
  superPool,
  queryApp,
  queryAppPrepared,
  runTenant,
  runTenantPrepared,
  withTenantTransaction,
  runSuper,
  runSuperPrepared,
  withSuperTransaction,
  ping,
  close
};
