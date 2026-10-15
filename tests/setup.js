/* Setup global dos testes.
   - Carrega o .env manualmente: dentro do Jest, `process.loadEnvFile`
     escreve no process.env real, mas cada arquivo de teste enxerga uma
     CÓPIA de process.env — as variáveis nunca chegavam aos testes.
   - Expõe dbAvailableSync(): suítes dependentes de banco decidem na
     coleção (Jest resolve describe antes dos hooks), por isso o probe
     síncrono em processo filho.
*/
const { execFileSync } = require('child_process');
const path = require('path');
const fs = require('fs');

function loadDotEnv(file) {
  if (!fs.existsSync(file)) return;
  const txt = fs.readFileSync(file, 'utf8');
  for (const raw of txt.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq < 1) continue;
    const key = line.slice(0, eq).trim();
    let val = line.slice(eq + 1).trim();
    if (
      (val.startsWith('"') && val.endsWith('"')) ||
      (val.startsWith("'") && val.endsWith("'"))
    ) {
      val = val.slice(1, -1);
    }
    // Variável já definida no ambiente tem precedência (CI injeta as suas)
    if (!(key in process.env)) process.env[key] = val;
  }
}

loadDotEnv(path.join(__dirname, '..', '.env'));

const ROOT = path.join(__dirname, '..');

function dbAvailableSync() {
  if (!process.env.DATABASE_URL) return false;
  const probe = [
    "const {Pool}=require('pg');",
    'const p=new Pool({connectionString:process.env.DATABASE_URL,connectionTimeoutMillis:4000,max:1});',
    "p.query('SELECT 1').then(()=>process.exit(0)).catch(()=>process.exit(1));"
  ].join('');
  try {
    execFileSync(process.execPath, ['-e', probe], {
      cwd: ROOT,
      stdio: 'ignore',
      timeout: 15000,
      env: process.env
    });
    return true;
  } catch (e) {
    return false;
  }
}

module.exports = { dbAvailableSync, loadDotEnv };
