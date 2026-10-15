/* Backup ponta a ponta: dado real -> dump -> restauro em banco descartável.

   O teste cria um tenant de serviço (marcado como teste), faz o dump,
   restaura num banco novo com migrations, compara contagens e limpa tudo.
   Sem pg_dump: usa o caminho JSON, que é o que roda em servidor enxuto.
*/
'use strict';

const path = require('path');
const fs = require('fs');
const { Client, Pool } = require('pg');
const crypto = require('crypto');

const backupLib = require('../lib/backup');
const { provisionTenant } = require('../services/provisioning');
const { hashPass } = require('../lib/passwords');
const { runMigrations } = require('../scripts/migrate');
const { dbAvailableSync } = require('./setup');

const app = require('../server').app;
const request = require('supertest');

const RUN = crypto.randomBytes(4).toString('hex');
const SCRATCH = `cardapio_bkptest_${RUN}`;

let connection = null;
let tenantId = null;
let superAdminId = null;
let createdArtifacts = [];

function client(db) {
  const c = { ...connection, database: db || connection.database };
  return new Client({
    host: c.host, port: Number(c.port), database: c.database,
    user: c.user, password: c.password
  });
}

const DB_UP = dbAvailableSync();

beforeAll(async () => {
  connection = backupLib.backupConnection();
  if (!DB_UP) return;

  const criado = await provisionTenant({
    name: 'Loja Teste de Backup',
    subdomain: `bkpteste-${RUN}`,
    slug: `bkpteste-${RUN}`,
    adminEmail: `bkp-${RUN}@exemplo.com`,
    adminPassword: 'SenhaForte123',
    adminName: 'Admin Backup',
    plan: 'free'
  });
  tenantId = criado.tenantId;

  const sa = await backupLib.createPool(connection).query('SELECT 1').then(() => null).catch(() => null);
  void sa;

  const admin = await client().connect().then(async c => {
    const r = await c.query(
      `INSERT INTO super_admins (email, password_hash, name, active)
       VALUES ($1, $2, 'Super Backup Teste', TRUE) RETURNING id`,
      [`bkp-super-${RUN}@plataforma.com`, hashPass('SenhaForte123')]
    );
    await c.end();
    return r.rows[0].id;
  });
  superAdminId = admin;

  // banco descartável com schema pronto para receber o restauro
  const maint = await client().connect();
  await maint.query(`DROP DATABASE IF EXISTS ${SCRATCH}`);
  await maint.query(`CREATE DATABASE ${SCRATCH}`);
  await maint.end();

  const url = `postgresql://${encodeURIComponent(connection.user)}:${encodeURIComponent(connection.password)}` +
    `@${connection.host}:${connection.port}/${SCRATCH}`;
  await runMigrations(url);
});

afterAll(async () => {
  if (!DB_UP) return;
  const maint = await client().connect();
  await maint.query(`DROP DATABASE IF EXISTS ${SCRATCH}`).catch(() => {});
  await maint.end();

  if (superAdminId) {
    const pool = backupLib.createPool(connection);
    await pool.query('DELETE FROM super_admins WHERE id = $1', [superAdminId]).catch(() => {});
    await pool.end();
  }
  if (tenantId) {
    const pool = backupLib.createPool(connection);
    for (const t of ['config', 'users']) {
      await pool.query(`DELETE FROM ${t} WHERE tenant_id = $1`, [tenantId]).catch(() => {});
    }
    await pool.query('DELETE FROM tenants WHERE id = $1', [tenantId]).catch(() => {});
    await pool.end();
  }
  for (const f of createdArtifacts) fs.rmSync(f, { force: true });
});

(DB_UP ? describe : describe.skip)('backup e restauro', () => {
  test('ordem topológica respeita as FKs (pais antes dos filhos)', async () => {
    const pool = backupLib.createPool(connection);
    try {
      const tables = await backupLib.listTables(pool);
      const order = await backupLib.topologicalOrder(pool, tables);
      expect(order).toHaveLength(tables.length);
      if (order.includes('tenants') && order.includes('users')) {
        expect(order.indexOf('tenants')).toBeLessThan(order.indexOf('users'));
      }
      if (order.includes('orders') && order.includes('order_items')) {
        expect(order.indexOf('orders')).toBeLessThan(order.indexOf('order_items'));
      }
    } finally {
      await pool.end();
    }
  });

  test('dump lógico captura os tenants (papel BYPASSRLS)', async () => {
    const pool = backupLib.createPool(connection);
    try {
      const dump = await backupLib.dumpToObject(pool);
      expect(dump.meta.format).toBe('json');
      expect(dump.tables.tenants).toBeDefined();
      expect(dump.tables.tenants.rows.length).toBeGreaterThan(0);
      expect(dump.tables.users.rows.length).toBeGreaterThan(0);
      expect(dump.tables.plans.rows.length).toBeGreaterThan(0);
    } finally {
      await pool.end();
    }
  });

  test('restore grava no banco descartável com contagens iguais', async () => {
    const pool = backupLib.createPool(connection);
    let dump;
    try {
      dump = await backupLib.dumpToObject(pool);
    } finally {
      await pool.end();
    }

    const file = await backupLib.writeDump(backupLib.backupDir(), dump);
    createdArtifacts.push(file);

    const scratchPool = backupLib.createPool({ ...connection, database: SCRATCH });
    try {
      const result = await backupLib.restoreFromObject(scratchPool, dump, { truncateAll: true });
      expect(result.tables).toBeGreaterThan(0);

      for (const table of ['tenants', 'users', 'plans', 'config']) {
        const origem = dump.tables[table] ? dump.tables[table].rows.length : 0;
        const r = await scratchPool.query(`SELECT COUNT(*)::int AS c FROM "${table}"`);
        expect(r.rows[0].c).toBe(origem);
      }
    } finally {
      await scratchPool.end();
    }
  });

  test('tabela com tenant_id some para o papel do app (RLS) — prova do motivo do bypass', async () => {
    // `tenants` é global (não tem tenant_id): os dois papéis leem igual.
    // O que a RLS esconde são as tabelas COM tenant_id, ex.: products.
    const appPool = new Pool({ connectionString: process.env.DATABASE_URL, max: 2 });
    try {
      const restrito = await appPool.query('SELECT COUNT(*)::int AS c FROM products');
      const superPool = backupLib.createPool(connection);
      const completo = await superPool.query('SELECT COUNT(*)::int AS c FROM products');
      await superPool.end();
      expect(Number(restrito.rows[0].c)).toBeLessThan(Number(completo.rows[0].c));
    } finally {
      await appPool.end();
    }
  });

  test('jsonb escalar (ex.: config.value = "23:00") sobrevive ao restauro', async () => {
    // Regressão: sem ::text no dump, o pg manda "23:00" como texto cru e o
    // Postgres rejeita (não é JSON válido). Aqui provamos o caminho inteiro.
    const pool = backupLib.createPool(connection);
    let dump;
    try {
      dump = await backupLib.dumpToObject(pool);
    } finally {
      await pool.end();
    }
    expect(dump.tables.config).toBeDefined();

    const scratchPool = backupLib.createPool({ ...connection, database: SCRATCH });
    try {
      await backupLib.restoreFromObject(scratchPool, dump, { truncateAll: true });
      const escalares = await scratchPool.query(
        `SELECT COUNT(*)::int AS c FROM config WHERE jsonb_typeof(value) = 'string'`
      );
      expect(escalares.rows[0].c).toBeGreaterThan(0);
      // e o valor continua legível como string
      const um = await scratchPool.query(`SELECT value FROM config WHERE jsonb_typeof(value) = 'string' LIMIT 1`);
      expect(typeof um.rows[0].value).toBe('string');
    } finally {
      await scratchPool.end();
    }
  });

  test('artefato inválido é rejeitado com erro claro', async () => {
    const pool = backupLib.createPool({ ...connection, database: SCRATCH });
    try {
      await expect(backupLib.restoreFromObject(pool, { lixo: true })).rejects.toThrow(/inválido/i);
      await expect(backupLib.restoreFromObject(pool, { tables: { tabela_fantasma: { columns: [], rows: [] } } }))
        .rejects.toThrow(/ausentes/);
    } finally {
      await pool.end();
    }
  });

  test('retenção mantém só os N mais recentes', async () => {
    const dir = path.join(require('os').tmpdir(), `bkp-retention-${RUN}`);
    fs.mkdirSync(dir, { recursive: true });
    const nomes = [];
    for (let i = 0; i < 5; i++) {
      const f = path.join(dir, `${backupLib.ARTIFACT_PREFIX}2026010${i}_120000.json`);
      fs.writeFileSync(f, '{}');
      nomes.push(f);
    }
    const before = backupLib.listArtifacts(dir);
    expect(before).toHaveLength(5);

    const pruned = backupLib.pruneArtifacts(2, dir);
    expect(pruned.kept).toBe(2);
    const after = backupLib.listArtifacts(dir);
    expect(after).toHaveLength(2);
    // os dois mais recentes sobreviveram
    expect(after[0].file).toContain('20260104');
    expect(fs.existsSync(nomes[4])).toBe(true);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test('listArtifacts devolve vazio quando o diretório não existe', () => {
    expect(backupLib.listArtifacts('C:\\diretorio\\que\\nao\\existe')).toEqual([]);
  });

  test('endpoint /api/super-admin/runtime continua autenticado após mudanças', async () => {
    const res = await request(app).get('/api/super-admin/runtime');
    expect([401, 403]).toContain(res.status);
  });
});
