// @ts-check
/* ============================================================
   lib/backup.js — backup/restore lógico (sem depender de pg_dump)

   Por que não pg_dump?
   - pg_dump --format=custom é o caminho canônico e segue suportado
     (useBackupCli), mas exige as ferramentas cliente do Postgres
     instaladas. Em servidor enxuto elas não existiam, e o backup
     simplesmente não rodava.

   Este módulo faz dump lógico via driver `pg`: lê todas as tabelas do
   schema public e grava JSON. Restauro = TRUNCATE + INSERT em ordem
   topológica (as FKs são validadas na hora, então a ordem importa).

   ATENÇÃO (bug que este módulo corrige): o backup precisa do papel
   BYPASSRLS (SUPER_ADMIN_DATABASE_URL). Com o papel do app, a RLS
   esconde as linhas dos outros tenants e o dump sai incompleto sem
   erro nenhum — a pior forma de backup falso.
   ============================================================ */
'use strict';

const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const { Pool } = require('pg');

/* Standalone scripts precisam do .env; em Jest o setup já cuida disso
   (e o Jest isola process.env, então loadEnvFile aqui seria inútil). */
try { process.loadEnvFile && process.loadEnvFile(); } catch { /* .env opcional */ }

const ARTIFACT_PREFIX = 'cardapio_backup_';
const DEFAULT_RETENTION = 14;

/** @param {string | undefined} url @returns {{host:string,port:string,database:string,user:string,password:string}} */
function parseConnection(url) {
  if (!url) throw new Error('DATABASE_URL não definida');
  const u = new URL(url);
  return {
    host: u.hostname,
    port: u.port || '5432',
    database: u.pathname.replace(/^\//, ''),
    user: u.username || process.env.PGUSER || 'postgres',
    password: u.password || process.env.PGPASSWORD || ''
  };
}

/**
 * Conexão de backup: SEMPRE o papel BYPASSRLS.
 * Com o papel do app a RLS esconderia as linhas dos outros tenants e o
 * dump sairia silenciosamente incompleto.
 */
function backupConnection() {
  return parseConnection(process.env.SUPER_ADMIN_DATABASE_URL || process.env.DATABASE_URL);
}

function backupDir() {
  return path.resolve(process.env.BACKUP_DIR || path.join(__dirname, '..', 'backups'));
}

/**
 * @param {string} dir
 * @returns {string}
 */
function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/**
 * @param {Date} [d]
 * @returns {string}
 */
function stamp(d = new Date()) {
  /** @param {number|string} n @param {number} [l] */
  const p = (n, l = 2) => String(n).padStart(l, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

/**
 * Tabelas do schema public, exceto as de controle de migração.
 * @param {import('pg').Pool} pool
 * @returns {Promise<string[]>}
 */
async function listTables(pool) {
  const r = await pool.query(
    `SELECT table_name FROM information_schema.tables
     WHERE table_schema = 'public' AND table_type = 'BASE TABLE'
       AND table_name <> 'schema_migrations'
     ORDER BY table_name`
  );
  return r.rows.map((/** @type {{ table_name: string }} */ x) => x.table_name);
}

/**
 * Ordem topológica (pais antes dos filhos) a partir das FKs.
 * Ciclos são quebrados na ordem alfabética (não deve aconterer neste schema).
 * @param {import('pg').Pool} pool
 * @param {string[]} tables
 * @returns {Promise<string[]>}
 */
async function topologicalOrder(pool, tables) {
  const r = await pool.query(
    `SELECT conrelid::regclass::text AS child, confrelid::regclass::text AS parent
     FROM pg_constraint WHERE contype = 'f'`
  );
  /** @type {Map<string, Set<string>>} */
  const deps = new Map(tables.map(t => [t, new Set()]));
  for (const row of r.rows) {
    const child = row.child.replace(/"([^"]+)"/g, '$1');
    const parent = row.parent.replace(/"([^"]+)"/g, '$1');
    const set = deps.get(child);
    if (set && deps.has(parent) && child !== parent) set.add(parent);
  }
  /** @type {string[]} */
  const out = [];
  /** @type {Set<string>} */
  const visited = new Set();
  /** @type {Set<string>} */
  const visiting = new Set();
  /** @param {string} t */
  const visit = (t) => {
    if (visited.has(t) || visiting.has(t)) return;
    visiting.add(t);
    for (const p of deps.get(t) || []) visit(p);
    visiting.delete(t);
    visited.add(t);
    out.push(t);
  };
  tables.forEach(visit);
  return out;
}

/** Colunas json/jsonb de uma tabela (precisam de ::text no dump).
 * @param {import('pg').Pool} pool @param {string} table @returns {Promise<string[]>} */
async function jsonColumns(pool, table) {
  const r = await pool.query(
    `SELECT column_name FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = $1 AND data_type IN ('json', 'jsonb')`,
    [table]
  );
  return r.rows.map((/** @type {{ column_name: string }} */ x) => x.column_name);
}

/**
 * Dump lógico em JSON: { meta, tables: { nome: { columns, rows } } }.
 *
 * Colunas json/jsonb são lidas com ::text: ao reinserir, o `pg` manda
 * string como texto cru, e `23:00` (jsonb escalar, sem aspas) não é JSON
 * válido — o restauro estouraria. Com ::text o valor já volta como
 * `"23:00"`, que é.
 * @param {import('pg').Pool} pool
 */
async function dumpToObject(pool) {
  const tables = await listTables(pool);
  const order = await topologicalOrder(pool, tables);
  /** @type {Record<string, { columns: string[], rows: unknown[][] }>} */
  const data = {};
  for (const table of order) {
    const jcols = await jsonColumns(pool, table);
    const cols = await pool.query(
      `SELECT column_name FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = $1 ORDER BY ordinal_position`,
      [table]
    );
    const select = cols.rows
      .map(c => (jcols.includes(c.column_name) ? `"${c.column_name}"::text` : `"${c.column_name}"`))
      .join(', ');
    // rowMode 'array': as linhas voltam como ARRAYS na ordem de `fields`,
    // o que casa com `columns` na hora de restaurar (e deixa o JSON curto).
    const r = await pool.query({ text: `SELECT ${select} FROM "${table}"`, rowMode: 'array' });
    data[table] = {
      columns: r.fields.map(f => f.name),
      rows: r.rows
    };
  }
  return { meta: { format: 'json', version: 1, createdAt: new Date().toISOString() }, tables: data };
}

/**
 * Serializa para arquivo.
 * @param {string} targetDir
 * @param {unknown} dump
 * @returns {Promise<string>} caminho escrito
 */
async function writeDump(targetDir, dump) {
  ensureDir(targetDir);
  const file = path.join(targetDir, `${ARTIFACT_PREFIX}${stamp()}.json`);
  await fs.promises.writeFile(file, JSON.stringify(dump));
  return file;
}

/**
 * Restaura um dump JSON dentro de uma transação.
 * @param {import('pg').Pool} pool
 * @param {{ tables: Record<string, { columns: string[], rows: unknown[][] }> }} dump
 * @param {{ truncateAll?: boolean }} [options]
 */
async function restoreFromObject(pool, dump, options = {}) {
  if (!dump || typeof dump !== 'object' || !dump.tables) throw new Error('Artefato de backup inválido');
  const tables = await listTables(pool);
  const order = await topologicalOrder(pool, tables);
  const present = order.filter(t => dump.tables[t]);
  const missing = Object.keys(dump.tables).filter(t => !tables.includes(t));
  if (missing.length) throw new Error('Tabelas do backup ausentes no destino: ' + missing.join(', '));

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    if (options.truncateAll !== false) {
      await client.query(`TRUNCATE ${present.map(t => `"${t}"`).join(', ')} RESTART IDENTITY CASCADE`);
    }
    for (const table of present) {
      const { columns, rows } = dump.tables[table];
      if (!rows.length) continue;
      const cols = columns.map(c => `"${c}"`).join(', ');
      for (let i = 0; i < rows.length; i += 100) {
        const chunk = rows.slice(i, i + 100);
        /** @type {any[]} */
        const values = [];
        /** @type {string[]} */
        const params = [];
        chunk.forEach(row => {
          const ph = row.map((_, ci) => { values.push(row[ci]); return `$${values.length}`; }).join(', ');
          params.push(`(${ph})`);
        });
        await client.query(`INSERT INTO "${table}" (${cols}) VALUES ${params.join(', ')}`, values);
      }
    }
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
  return { tables: present.length, order: present };
}

/** Artefatos conhecidos (json do dump lógico, .dump do pg_dump, .tar.gz dos assets). */
const ARTIFACT_EXTS = ['.json', '.dump', '.tar.gz'];

/**
 * @param {string} file
 * @returns {boolean}
 */
function isArtifact(file) {
  if (!file.startsWith(ARTIFACT_PREFIX)) return false;
  return ARTIFACT_EXTS.some(ext => file.endsWith(ext));
}

/** Lista artefatos mais recentes primeiro (o nome começa com o timestamp). */
function listArtifacts(dir = backupDir()) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir)
    .filter(isArtifact)
    .sort()
    .reverse()
    .map(f => ({ file: f, path: path.join(dir, f), size: fs.statSync(path.join(dir, f)).size }));
}

/** Mantém só os N mais recentes de cada tipo (por nome, que começa com o timestamp). */
function pruneArtifacts(keep = DEFAULT_RETENTION, dir = backupDir()) {
  const all = listArtifacts(dir);
  /** @type {Map<string, typeof all>} */
  const porTipo = new Map();
  for (const a of all) {
    const ext = ARTIFACT_EXTS.find((/** @type {string} */ e) => a.file.endsWith(e));
    if (!ext) continue;
    const grupo = porTipo.get(ext);
    if (grupo) grupo.push(a);
    else porTipo.set(ext, [a]);
  }
  const removed = [];
  for (const grupo of porTipo.values()) {
    for (const a of grupo.slice(keep)) {
      fs.rmSync(a.path, { force: true });
      removed.push(a.file);
    }
  }
  return { kept: all.length - removed.length, removed };
}

/**
 * Backup via pg_dump --format=custom (canônico, quando as ferramentas existem).
 * @param {{host:string,port:string,database:string,user:string,password:string}} connection
 * @param {string} targetDir
 * @returns {Promise<{ok: boolean, reason?: string, file?: string}>}
 */
function dumpWithCli(connection, targetDir) {
  return new Promise(resolve => {
    ensureDir(targetDir);
    const file = path.join(targetDir, `${ARTIFACT_PREFIX}${stamp()}.dump`);
    const args = ['--format=custom', '--no-owner', '--no-privileges',
      '--host', connection.host, '--port', connection.port,
      '--username', connection.user, '--dbname', connection.database, '--file', file];
    const env = { ...process.env };
    if (connection.password) env.PGPASSWORD = connection.password;
    execFile('pg_dump', args, { env, timeout: 10 * 60 * 1000 }, (error, _stdout, stderr) => {
      if (error) {
        try { fs.rmSync(file, { force: true }); } catch { /* já removido */ }
        resolve({ ok: false, reason: (stderr || error.message).trim().slice(0, 300) });
        return;
      }
      resolve({ ok: true, file });
    });
  });
}

/**
 * Arquiva os assets (imagens) das lojas em .tar.gz.
 * O banco sozinho não é backup completo: produto sem imagem é pedido perdido.
 * @param {string} assetsDir diretório data/tenants
 * @param {string} targetDir destino
 * @returns {Promise<{ok: boolean, file?: string, reason?: string, files?: number}>}
 */
function archiveAssets(assetsDir, targetDir) {
  return new Promise(resolve => {
    if (!fs.existsSync(assetsDir)) {
      resolve({ ok: false, reason: 'diretório de assets não existe' });
      return;
    }
    const entries = fs.readdirSync(assetsDir);
    if (!entries.length) {
      resolve({ ok: false, reason: 'nenhum asset para arquivar' });
      return;
    }
    ensureDir(targetDir);
    const file = path.join(targetDir, `${ARTIFACT_PREFIX}assets_${stamp()}.tar.gz`);
    // tar existe no Windows 10+ (System32\tar.exe) e em qualquer Linux
    execFile('tar', ['-czf', file, '-C', assetsDir, ...entries], { timeout: 10 * 60 * 1000 }, error => {
      if (error) {
        try { fs.rmSync(file, { force: true }); } catch { /* já removido */ }
        resolve({ ok: false, reason: (error.message || '').slice(0, 200) });
        return;
      }
      resolve({ ok: true, file, files: entries.length });
    });
  });
}

/**
 * @param {{host:string,port:string,database:string,user:string,password:string}} connection
 * @param {Object} [extra]
 * @returns {import('pg').Pool}
 */
function createPool(connection, extra = {}) {
  return new Pool({
    host: connection.host,
    port: Number(connection.port),
    database: connection.database,
    user: connection.user,
    password: connection.password,
    max: 4,
    ...extra
  });
}

module.exports = {
  ARTIFACT_PREFIX,
  DEFAULT_RETENTION,
  parseConnection,
  backupConnection,
  backupDir,
  ensureDir,
  stamp,
  listTables,
  jsonColumns,
  topologicalOrder,
  dumpToObject,
  writeDump,
  restoreFromObject,
  listArtifacts,
  pruneArtifacts,
  archiveAssets,
  dumpWithCli,
  createPool
};
