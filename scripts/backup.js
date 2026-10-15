#!/usr/bin/env node
/* ============================================================
   Backup do banco + assets das lojas

   Uso:
     npm run backup                 # dump lógico JSON (sempre funciona)
     npm run backup -- --cli        # usa pg_dump quando disponível
     npm run backup -- --keep 30    # retenção customizada

   O dump usa SEMPRE a conexão BYPASSRLS (SUPER_ADMIN_DATABASE_URL):
   com o papel do app a RLS esconderia os outros tenants e o backup
   sairia incompleto sem erro.

   Agendamento:
     Linux  (cron, 3h da manhã):
       0 3 * * * cd /caminho/do/saas && /usr/bin/npm run backup >> backups/cron.log 2>&1
     Windows (Tarefas agendadas):
       schtasks /Create /SC DAILY /ST 03:00 /TN "CardapioBackup" ^
         /TR "cd /d C:\caminho\do\saas && npm run backup"
   ============================================================ */
'use strict';

const path = require('path');
const fs = require('fs');
const backup = require('../lib/backup');
const logger = require('../lib/logger');

const KEEP = Number(process.argv.includes('--keep')
  ? process.argv[process.argv.indexOf('--keep') + 1]
  : backup.DEFAULT_RETENTION);

async function main() {
  const started = Date.now();
  const connection = backup.backupConnection();
  const dir = backup.backupDir();
  backup.ensureDir(dir);

  let artifact = null;
  let mode = 'json';

  if (process.argv.includes('--cli')) {
    const cli = await backup.dumpWithCli(connection, dir);
    if (cli.ok) {
      artifact = cli.file;
      mode = 'pg_dump';
    } else {
      logger.warn('backup_cli_indisponivel', { reason: cli.reason, fallback: 'json' });
    }
  }

  if (!artifact) {
    const pool = backup.createPool(connection);
    try {
      const dump = await backup.dumpToObject(pool);
      const counts = Object.fromEntries(Object.entries(dump.tables).map(([t, d]) => [t, d.rows.length]));
      artifact = await backup.writeDump(dir, dump);
      logger.info('backup_created', {
        file: path.basename(artifact),
        size_bytes: fs.statSync(artifact).size,
        mode,
        tables: Object.keys(counts).length,
        tenants: counts.tenants || 0,
        products: counts.products || 0,
        orders: counts.orders || 0,
        duration_ms: Date.now() - started
      });
    } finally {
      await pool.end();
    }
  } else {
    logger.info('backup_created', { file: path.basename(artifact), mode, size_bytes: fs.statSync(artifact).size, duration_ms: Date.now() - started });
  }

  const pruned = backup.pruneArtifacts(KEEP);
  if (pruned.removed.length) {
    logger.info('backup_pruned', { keep: KEEP, removed: pruned.removed.length, files: pruned.removed });
  }

  /* Imagens dos produtos: o banco não as guarda. Sem este passo o restore
     volta com todos os produtos apontando para arquivos inexistentes. */
  const assetsDir = path.join(__dirname, '..', 'data', 'tenants');
  const assets = await backup.archiveAssets(assetsDir, dir);
  if (assets.ok) {
    logger.info('assets_backup_created', {
      file: path.basename(assets.file),
      size_bytes: fs.statSync(assets.file).size,
      dirs: assets.files
    });
    console.log(`Assets arquivados: ${assets.file}`);
  } else {
    logger.warn('assets_backup_skipped', { reason: assets.reason });
  }

  console.log(`Backup concluído: ${artifact}`);
}

main().catch(e => {
  logger.error('backup_failed', { message: e.message, ...(e.stack ? { stack: e.stack } : {}) });
  process.exit(1);
});
