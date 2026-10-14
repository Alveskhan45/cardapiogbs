/* ============================================================
   scripts/migrate.js — aplica as migrations da pasta migrations/
   em ordem numérica, uma única vez (tabela schema_migrations).

   Roda com o papel super-admin (BYPASSRLS), pois além do DDL faz
   GRANT nas tabelas criadas para o papel do app. Em ambientes com
   usuário único (RDS/etc.) o GRANT falha e é ignorado de propósito.

   Uso:  node scripts/migrate.js
   (o boot do server.js também roda as migrations pendentes — dev DX)
   ============================================================ */
'use strict';

const fs = require('fs');
const path = require('path');
const { Client } = require('pg');

try { process.loadEnvFile && process.loadEnvFile(); } catch (e) { /* opcional */ }

const MIGRATIONS_DIR = path.join(__dirname, '..', 'migrations');

async function runMigrations(url) {
  const connectionString = url || process.env.SUPER_ADMIN_DATABASE_URL || process.env.DATABASE_URL;
  if (!connectionString) throw new Error('DATABASE_URL / SUPER_ADMIN_DATABASE_URL não definidos');

  const client = new Client({ connectionString });
  await client.connect();

  try {
    await client.query(
      'CREATE TABLE IF NOT EXISTS schema_migrations (filename TEXT PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW())'
    );

    const files = fs
      .readdirSync(MIGRATIONS_DIR)
      .filter(f => f.endsWith('.sql'))
      .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));

    for (const file of files) {
      const done = await client.query('SELECT 1 FROM schema_migrations WHERE filename = $1', [file]);
      if (done.rows.length) continue;

      const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, file), 'utf8');
      console.log(`[migrate] aplicando ${file} ...`);
      await client.query('BEGIN');
      try {
        await client.query(sql);
        await client.query('INSERT INTO schema_migrations (filename) VALUES ($1)', [file]);
        await client.query('COMMIT');
      } catch (e) {
        await client.query('ROLLBACK').catch(() => {});
        console.error(`[migrate] FALHOU em ${file}:`, e.message);
        throw e;
      }
      console.log(`[migrate] ok ${file}`);
    }

    // Privilégios DML para o papel do app (idempotente; ignora falhas em
    // ambientes com usuário único onde os papéis não existem).
    const grants = [
      'GRANT ALL ON ALL TABLES IN SCHEMA public TO cardapio_app',
      'GRANT ALL ON ALL SEQUENCES IN SCHEMA public TO cardapio_app',
      'GRANT ALL ON ALL TABLES IN SCHEMA public TO cardapio_admin'
    ];
    for (const g of grants) {
      try { await client.query(g); } catch (e) { /* usuário único: sem papéis para conceder */ }
    }

    return files;
  } finally {
    await client.end();
  }
}

if (require.main === module) {
  runMigrations()
    .then(() => {
      console.log('[migrate] banco em dia ✔');
      process.exit(0);
    })
    .catch(e => {
      console.error(e.message);
      process.exit(1);
    });
}

module.exports = { runMigrations };
