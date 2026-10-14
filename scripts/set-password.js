/* ============================================================
   scripts/set-password.js — cria ou troca a senha de um usuário

   Útil quando a senha do painel antigo não é conhecida (na
   migração o hash antigo é preservado, então ninguém pode
   adivinhar a senha) ou quando alguém perdeu o acesso.

   Exemplos:
     node scripts/set-password.js --email=admin@legado.com --senha=novasenha123
     node scripts/set-password.js --email=admin@legado.com --senha=123456 --tenant=legado
     node scripts/set-password.js --email=nova@loja.com --senha=123456 --nome="João" --role=operator
     node scripts/set-password.js --listar
     node scripts/set-password.js --gerar --email=admin@legado.com
   ============================================================ */
'use strict';

try { process.loadEnvFile && process.loadEnvFile(); } catch (e) { /* opcional */ }

const { v4: uuidv4 } = require('uuid');
const db = require('../db');
const { hashPass, generatePassword } = require('../lib/passwords');

function arg(name, def) {
  const hit = process.argv.find(a => a.startsWith('--' + name + '='));
  if (hit) return hit.slice(name.length + 3);
  const i = process.argv.indexOf('--' + name);
  if (i >= 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith('--')) return process.argv[i + 1];
  return def;
}
const has = name =>
  process.argv.includes('--' + name) || process.argv.some(a => a.startsWith('--' + name + '='));

async function main() {
  // Plataforma: --super=<email> troca/cria o super-admin
  if (has('super')) {
    const supEmail = String(arg('super', '') || arg('email', '')).trim().toLowerCase();
    if (!supEmail) {
      console.error('Informe --super=email@dominio.com');
      await db.close();
      process.exit(1);
    }
    const supPass = String(arg('senha', '')).trim() || generatePassword(12);
    const supName = arg('nome', '') || 'Super Admin';
    const hash = hashPass(supPass);
    const found = await db.runSuper('SELECT id FROM super_admins WHERE lower(email) = $1', [supEmail]);
    if (found.rows.length) {
      await db.runSuper('UPDATE super_admins SET password_hash = $1, active = TRUE WHERE id = $2', [hash, found.rows[0].id]);
      console.log('Senha do super-admin atualizada.');
    } else {
      const { v4: uuid } = require('uuid');
      await db.runSuper(
        'INSERT INTO super_admins (id, email, password_hash, name, active) VALUES ($1, $2, $3, $4, TRUE)',
        [uuid(), supEmail, hash, supName]
      );
      console.log('Super-admin criado.');
    }
    console.log('');
    console.log('  E-mail:', supEmail);
    console.log('  Senha :', supPass);
    console.log('  Painel : /pages/super-admin.html');
    console.log('');
    await db.close();
    return;
  }

  if (has('listar')) {
    const r = await db.runSuper(`
      SELECT t.subdomain, t.name AS loja, u.email, u.role, u.active, u.last_login
      FROM users u JOIN tenants t ON t.id = u.tenant_id
      ORDER BY t.subdomain, u.created_at
    `);
    console.table(r.rows);
    await db.close();
    return;
  }

  const email = String(arg('email', '')).trim().toLowerCase();
  if (!email) {
    console.error('Informe --email= (ou use --listar para ver os usuários)');
    await db.close();
    process.exit(1);
  }

  const tenantSub = String(arg('tenant', '')).trim().toLowerCase();
  const senha = String(arg('senha', '')).trim() || generatePassword(12);
  const nome = arg('nome', '') || null;
  const role = ['admin', 'operator', 'viewer'].includes(arg('role', '')) ? arg('role') : 'admin';

  if (senha.length < 4) {
    console.error('Senha muito curta (mín. 4).');
    await db.close();
    process.exit(1);
  }

  // Descobre o tenant: pelo subdomínio informado ou procurando o e-mail em todos.
  let tenant;
  if (tenantSub) {
    const r = await db.runSuper('SELECT id, subdomain, name FROM tenants WHERE subdomain = $1 OR slug = $1', [tenantSub]);
    tenant = r.rows[0];
    if (!tenant) {
      console.error('Loja não encontrada: ' + tenantSub);
      await db.close();
      process.exit(1);
    }
  } else {
    const r = await db.runSuper(
      `SELECT t.id, t.subdomain, t.name FROM users u JOIN tenants t ON t.id = u.tenant_id
       WHERE lower(u.email) = $1 ORDER BY t.created_at`,
      [email]
    );
    if (!r.rows.length) {
      const all = await db.runSuper('SELECT id, subdomain, name FROM tenants ORDER BY created_at');
      if (all.rows.length !== 1) {
        console.error('E-mail não existe em nenhuma loja. Informe --tenant=subdominio.');
        console.table(all.rows.map(x => ({ loja: x.name, subdominio: x.subdomain })));
        await db.close();
        process.exit(1);
      }
      tenant = all.rows[0];
    } else {
      tenant = r.rows[0];
    }
  }

  const hash = hashPass(senha);
  const existing = await db.runSuper('SELECT id FROM users WHERE tenant_id = $1 AND lower(email) = $2', [tenant.id, email]);

  if (existing.rows.length) {
    await db.runSuper(
      'UPDATE users SET password_hash = $1, active = TRUE, updated_at = NOW() WHERE id = $2',
      [hash, existing.rows[0].id]
    );
    await db.runSuper('UPDATE refresh_tokens SET revoked_at = NOW() WHERE user_id = $1 AND revoked_at IS NULL', [existing.rows[0].id]);
    console.log('Senha atualizada.');
  } else {
    await db.runSuper(
      `INSERT INTO users (id, tenant_id, email, password_hash, name, role, active)
       VALUES ($1, $2, $3, $4, $5, $6, TRUE)`,
      [uuidv4(), tenant.id, email, hash, nome || email.split('@')[0], role]
    );
    console.log('Usuário criado.');
  }

  console.log('');
  console.log('  Loja  :', tenant.name, '(' + tenant.subdomain + ')');
  console.log('  E-mail:', email);
  console.log('  Senha :', senha);
  console.log('');
  await db.close();
}

main().catch(async e => {
  console.error('Falha:', e.message);
  await db.close().catch(() => {});
  process.exit(1);
});
