#!/usr/bin/env node
/* ============================================================
   Verifica um backup restaurando de verdade num banco descartável

   Um backup que ninguém restaura é um backup não testado. Este script:
     1. cria o banco cardapio_verify_<timestamp>
     2. roda as migrations nele
     3. restaura o artefato mais recente (ou --file)
     4. confere sanidade (linhas nas tabelas críticas)
     5. derruba o banco de verificação

   Uso: npm run backup:verify  |  npm run backup:verify -- --file x.json
   ============================================================ */
'use strict';

const path = require('path');
const fs = require('fs');
const { Client } = require('pg');
const backup = require('../lib/backup');
const { runMigrations } = require('./migrate');
const logger = require('../lib/logger');

function arg(name, fallback = null) {
  const i = process.argv.indexOf('--' + name);
  return i > 0 ? process.argv[i + 1] : fallback;
}

const CHECK_TABLES = ['tenants', 'users', 'config', 'plans', 'products', 'orders'];

async function main() {
  const connection = backup.backupConnection();
  const artifacts = backup.listArtifacts();
  const requested = arg('file');
  const artifact = requested
    ? artifacts.find(a => a.path === path.resolve(requested))
    : artifacts[0];

  if (!artifact) {
    console.error('Nenhum artefato para verificar. Rode `npm run backup` primeiro.');
    process.exit(1);
  }

  const scratch = `cardapio_verify_${backup.stamp()}`;
  const started = Date.now();

  // conexão de manutenção (banco principal) para CREATE/DROP DATABASE
  const maint = new Client({
    host: connection.host,
    port: Number(connection.port),
    database: connection.database,
    user: connection.user,
    password: connection.password
  });
  await maint.connect();
  try {
    await maint.query(`DROP DATABASE IF EXISTS ${scratch}`);
    await maint.query(`CREATE DATABASE ${scratch}`);
    logger.info('backup_verify_scratch_created', { database: scratch });
  } finally {
    await maint.end();
  }

  let pool = null;
  try {
    const scratchConn = { ...connection, database: scratch };
    const migrations = await runMigrations(
      `postgresql://${encodeURIComponent(scratchConn.user)}:${encodeURIComponent(scratchConn.password)}` +
      `@${scratchConn.host}:${scratchConn.port}/${scratchConn.database}`
    );
    logger.info('backup_verify_migrations', { applied: Array.isArray(migrations) ? migrations.length : 0 });

    pool = backup.createPool(scratchConn);
    const dump = JSON.parse(fs.readFileSync(artifact.path, 'utf8'));
    const result = await backup.restoreFromObject(pool, dump, { truncateAll: true });

    const checks = {};
    for (const t of CHECK_TABLES) {
      const r = await pool.query(`SELECT COUNT(*)::int AS c FROM "${t}"`);
      checks[t] = r.rows[0].c;
    }
    const empty = CHECK_TABLES.filter(t => checks[t] === 0);
    if (empty.length) {
      throw new Error('Backup restaurado mas tabelas vazias: ' + empty.join(', '));
    }

    logger.info('backup_verified', {
      file: artifact.file,
      tables: result.tables,
      counts: checks,
      duration_ms: Date.now() - started
    });
    console.log(`Backup OK: ${artifact.file} restaurou em ${scratch} com ${checks.tenants} tenant(s), ${checks.products || 0} produto(s).`);
  } finally {
    if (pool) await pool.end();
    const drop = new Client({
      host: connection.host,
      port: Number(connection.port),
      database: connection.database,
      user: connection.user,
      password: connection.password
    });
    await drop.connect();
    await drop.query(`DROP DATABASE IF EXISTS ${scratch}`).catch(e => {
      logger.warn('backup_verify_scratch_drop_failed', { database: scratch, message: e.message });
    });
    await drop.end();
    logger.info('backup_verify_scratch_dropped', { database: scratch });
  }
}

main().catch(e => {
  logger.error('backup_verify_failed', { message: e.message });
  process.exit(1);
});
