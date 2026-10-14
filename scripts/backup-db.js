'use strict';

const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');

try { process.loadEnvFile && process.loadEnvFile(); } catch (e) { /* opcional */ }

const CONNECTION = process.env.DATABASE_URL || process.env.SUPER_ADMIN_DATABASE_URL;
const BACKUP_DIR = path.resolve(process.env.BACKUP_DIR || path.join(__dirname, '..', 'backups'));

if (!CONNECTION) {
  console.error('[backup-db] DATABASE_URL não definida');
  process.exit(1);
}

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function parseConnectionString(url) {
  try {
    const u = new URL(url);
    return {
      host: u.hostname,
      port: u.port || '5432',
      database: u.pathname.replace(/^\//, ''),
      user: u.username || process.env.PGUSER || 'postgres',
      password: u.password || process.env.PGPASSWORD || ''
    };
  } catch (e) {
    return null;
  }
}

function dumpFileName() {
  const d = new Date();
  return `cardapio_backup_${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}_${String(d.getHours()).padStart(2, '0')}${String(d.getMinutes()).padStart(2, '0')}.dump`;
}

function run() {
  ensureDir(BACKUP_DIR);
  const cfg = parseConnectionString(CONNECTION);
  if (!cfg) {
    console.error('[backup-db] DATABASE_URL inválida');
    process.exit(1);
  }

  const targetFile = path.join(BACKUP_DIR, dumpFileName());
  const args = ['--format=custom', '--verbose'];
  const env = { ...process.env };

  if (cfg.password) env.PGPASSWORD = cfg.password;
  args.push('--host', cfg.host);
  args.push('--port', cfg.port);
  args.push('--username', cfg.user);
  args.push('--dbname', cfg.database);
  args.push('--file', targetFile);

  console.log(`[backup-db] exportando ${cfg.database} para ${targetFile}`);
  execFile('pg_dump', args, { env }, (error, stdout, stderr) => {
    if (error) {
      console.error('[backup-db] falha no backup');
      if (stdout) console.error(stdout.trim());
      if (stderr) console.error(stderr.trim());
      process.exit(1);
    }
    if (stdout) console.log(stdout.trim());
    if (stderr) console.log(stderr.trim());
    console.log(`[backup-db] OK: ${targetFile}`);
  });
}

run();
