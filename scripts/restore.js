#!/usr/bin/env node
/* ============================================================
   Restaura um backup

   Uso:
     npm run restore                              # lista artefatos e sai
     npm run restore -- --file backups/x.json     # restaura no banco do .env
     npm run restore -- --file backups/x.json --to postgresql://...cardapio_scratch

   Segurança:
     - Restaurar no banco principal EXIGE --i-know-this-destroys-data.
     - Sem --to, o alvo é o banco do .env (DATABASE_URL).
     - O restore roda em uma transação: ou entra tudo, ou não entra nada.
   ============================================================ */
'use strict';

const fs = require('fs');
const backup = require('../lib/backup');
const logger = require('../lib/logger');

function arg(name, fallback = null) {
  const i = process.argv.indexOf('--' + name);
  return i > 0 ? process.argv[i + 1] : fallback;
}

async function main() {
  const dir = backup.backupDir();
  const artifacts = backup.listArtifacts(dir);

  const requested = arg('file');
  const artifact = requested ? artifacts.find(a => a.path === require('path').resolve(requested) || a.file === requested) : artifacts[0];

  if (!artifact) {
    console.log('Nenhum artefato encontrado em ' + dir);
    if (!artifacts.length) process.exit(1);
    console.log('\nArtefatos disponíveis (mais recente primeiro):');
    artifacts.slice(0, 10).forEach((a, i) => console.log(`  ${i + 1}. ${a.file}  (${(a.size / 1024).toFixed(1)} KB)`));
    console.log('\nUso: npm run restore -- --file <arquivo> --i-know-this-destroys-data');
    process.exit(0);
  }

  if (requested && !fs.existsSync(artifact.path)) {
    console.error('Arquivo não encontrado: ' + requested);
    process.exit(1);
  }

  const target = arg('to');
  if (!target && !process.argv.includes('--i-know-this-destroys-data')) {
    console.error('RECUSADO: restaurar sobrescreve o banco atual.');
    console.error('Confirme com --i-know-this-destroys-data (ou use --to <conexão> para alvo alternativo).');
    process.exit(2);
  }

  const connection = target ? backup.parseConnection(target) : backup.backupConnection();
  const started = Date.now();
  const pool = backup.createPool(connection);

  try {
    const dump = JSON.parse(fs.readFileSync(artifact.path, 'utf8'));
    const result = await backup.restoreFromObject(pool, dump, { truncateAll: true });
    logger.info('restore_done', {
      file: artifact.file,
      target_database: connection.database,
      tables: result.tables,
      duration_ms: Date.now() - started
    });
    console.log(`Restaurado ${artifact.file} em ${connection.database} (${result.tables} tabelas).`);
  } catch (e) {
    if (/ausentes no destino/.test(e.message)) {
      console.error('O banco de destino está sem o schema.');
      console.error('Rode as migrations lá primeiro: coloque essa conexão em DATABASE_URL e execute `npm run migrate`.');
      console.error('Dica: para validar um backup sem risco, use `npm run backup:verify` (cria banco descartável).');
    }
    throw e;
  } finally {
    await pool.end();
  }
}

main().catch(e => {
  logger.error('restore_failed', { message: e.message });
  process.exit(1);
});
