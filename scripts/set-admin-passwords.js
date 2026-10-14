#!/usr/bin/env node
/* ============================================================
   Script: Define senha 'admin123' para todos os admins de todos os tenants
   Uso: node scripts/set-admin-passwords.js
   ============================================================ */

'use strict';

/* Carregar .env nativamente (Node 20+) */
try { process.loadEnvFile && process.loadEnvFile(); } catch (e) {}

const { Pool } = require('pg');
const crypto = require('crypto');

const SUPER_ADMIN_DATABASE_URL = process.env.SUPER_ADMIN_DATABASE_URL || process.env.DATABASE_URL;

if (!SUPER_ADMIN_DATABASE_URL) {
  console.error('❌ DATABASE_URL ou SUPER_ADMIN_DATABASE_URL não definida no .env');
  process.exit(1);
}

const superPool = new Pool({ 
  connectionString: SUPER_ADMIN_DATABASE_URL, 
  max: 5, 
  application_name: 'set-admin-passwords' 
});

/* Mesmo algoritmo do lib/passwords.js */
function hashPass(pass) {
  const salt = crypto.randomBytes(16).toString('hex');
  const buf = crypto.scryptSync('bebidas::' + (pass || ''), salt, 64);
  return 'scrypt$' + salt + '$' + buf.toString('hex');
}

const TARGET_PASSWORD = 'admin123';
const TARGET_HASH = hashPass(TARGET_PASSWORD);

async function main() {
  console.log('🔐 Definindo senha "admin123" para todos os admins...\n');
  console.log(`Hash gerado: ${TARGET_HASH}\n`);

  try {
    /* 1. Buscar todos os tenants */
    const tenantsResult = await superPool.query(`
      SELECT id, name, subdomain, plan, status 
      FROM tenants 
      ORDER BY created_at
    `);

    if (tenantsResult.rows.length === 0) {
      console.log('⚠️  Nenhum tenant encontrado.');
      return;
    }

    console.log(`📋 Encontrados ${tenantsResult.rows.length} tenant(s):\n`);

    for (const tenant of tenantsResult.rows) {
      console.log(`  → ${tenant.name} (${tenant.subdomain}) [${tenant.status}]`);

      try {
        /* 2. Verificar se já existe admin ativo */
        const usersResult = await superPool.query(`
          SELECT id, email, role, active 
          FROM users 
          WHERE tenant_id = $1 AND role = 'admin' AND active = true
          ORDER BY created_at
        `, [tenant.id]);

        if (usersResult.rows.length === 0) {
          /* 3. Criar admin se não existir */
          const email = `admin@${tenant.subdomain}.local`;
          
          await superPool.query(`
            INSERT INTO users (tenant_id, email, password_hash, name, role, active, created_at, updated_at)
            VALUES ($1, $2, $3, $4, 'admin', true, NOW(), NOW())
            ON CONFLICT (tenant_id, email) DO UPDATE SET
              password_hash = EXCLUDED.password_hash,
              role = 'admin',
              active = true,
              updated_at = NOW()
          `, [tenant.id, email, TARGET_HASH, 'Administrador']);

          console.log(`     ✅ Admin criado: ${email}`);
        } else {
          /* 4. Atualizar senha dos admins existentes */
          for (const user of usersResult.rows) {
            await superPool.query(`
              UPDATE users 
              SET password_hash = $1, updated_at = NOW()
              WHERE id = $2
            `, [TARGET_HASH, user.id]);

            console.log(`     ✅ Senha atualizada: ${user.email} (${user.id})`);
          }
        }

      } catch (e) {
        console.error(`     ❌ Erro no tenant ${tenant.subdomain}:`, e.message);
      }
    }

    console.log('\n✅ Concluído! Todos os admins agora usam senha: admin123');
    console.log('\n📝 Para testar:');
    console.log('   1. Acesse o cardápio da loja (ex: http://localhost:3001/?tenant=SUBDOMINIO)');
    console.log('   2. Clique em "Admin" no topo');
    console.log('   3. Digite a senha: admin123');
    console.log('   4. Se pedir email, use: admin@SUBDOMINIO.local');

  } catch (e) {
    console.error('\n❌ Erro geral:', e.message);
    console.error(e.stack);
  } finally {
    await superPool.end();
  }
}

main();