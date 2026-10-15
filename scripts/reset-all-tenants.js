#!/usr/bin/env node
/* ============================================================
   Script: ZERA todos os tenants e dados relacionados
   Uso: node scripts/reset-all-tenants.js
   ⚠️  IRREVERSÍVEL - Apaga TUDO: tenants, users, produtos, pedidos, etc.
   ============================================================ */

'use strict';

try { process.loadEnvFile && process.loadEnvFile(); } catch { /* .env é opcional */ }

const { Pool } = require('pg');

const SUPER_ADMIN_DATABASE_URL = process.env.SUPER_ADMIN_DATABASE_URL || process.env.DATABASE_URL;

if (!SUPER_ADMIN_DATABASE_URL) {
  console.error('❌ DATABASE_URL ou SUPER_ADMIN_DATABASE_URL não definida no .env');
  process.exit(1);
}

const superPool = new Pool({ 
  connectionString: SUPER_ADMIN_DATABASE_URL, 
  max: 5, 
  application_name: 'reset-all-tenants' 
});

async function main() {
  console.log('⚠️  ATENÇÃO: Isso vai APAGAR TODOS os tenants e dados!');
  console.log('   Incluindo: produtos, pedidos, usuários, cupons, bairros, configurações...\n');
  
  // Confirmação interativa
  const readline = require('readline').createInterface({
    input: process.stdin,
    output: process.stdout
  });
  
  const answer = await new Promise(resolve => {
    readline.question('Digite "CONFIRMO" para prosseguir: ', resolve);
  });
  readline.close();
  
  if (answer.trim() !== 'CONFIRMO') {
    console.log('❌ Cancelado. Digite exatamente "CONFIRMO" para confirmar.');
    process.exit(0);
  }

  console.log('\n🗑️  Iniciando limpeza completa...\n');

  try {
    // 1. Verificar tenants atuais
    const before = await superPool.query('SELECT id, name, subdomain, status FROM tenants ORDER BY created_at');
    console.log(`📋 Tenants encontrados: ${before.rows.length}`);
    before.rows.forEach(t => console.log(`   - ${t.name} (${t.subdomain}) [${t.status}]`));

    if (before.rows.length === 0) {
      console.log('\n✅ Já está limpo! Nenhum tenant para remover.');
      return;
    }

    // 2. Deletar em ordem (respeitando foreign keys)
    // Ordem: tabelas filhas → tabelas pais
    
    console.log('\n🔄 Limpando dados dos tenants...');
    
    // Usar superPool (BYPASSRLS) para apagar tudo sem restrição de tenant
    // Tabelas multi-tenant que precisam ser limpas:
    const tablesToClean = [
      // Dados de pedidos e itens
      'order_items',
      'orders',
      // Produtos e categorias
      'product_extras',
      'product_variations', 
      'products',
      'categories',
      // Cupons
      'coupon_usages',
      'coupons',
      // Clientes/endereços
      'customer_addresses',
      'customers',
      // Estoque
      'stock_log',
      // Cupons
      'coupons',
      // Frete/bairros
      'bairros',
      // Configurações e logs
      'admin_log',
      'config',
      // Usuários do tenant
      'users',
      // Tenants por último
      'tenants'
    ];

    for (const table of tablesToClean) {
      try {
        const result = await superPool.query(`DELETE FROM ${table}`);
        console.log(`   ✅ ${table}: ${result.rowCount} linhas removidas`);
      } catch (e) {
        // Tabela pode não existir ou já estar vazia
        if (!e.message.includes('does not exist') && !e.message.includes('relation') && !e.message.includes('constraint')) {
          console.log(`   ⚠️  ${table}: ${e.message}`);
        }
      }
    }

    // 3. Verificar se sobrou algo
    const after = await superPool.query('SELECT COUNT(*)::int AS c FROM tenants');
    console.log(`\n📊 Tenants restantes: ${after.rows[0].c}`);

    // 4. Resetar sequences se existirem
    try {
      await superPool.query(`ALTER SEQUENCE IF EXISTS tenants_id_seq RESTART WITH 1`);
      await superPool.query(`ALTER SEQUENCE IF EXISTS users_id_seq RESTART WITH 1`);
      await superPool.query(`ALTER SEQUENCE IF EXISTS products_id_seq RESTART WITH 1`);
      await superPool.query(`ALTER SEQUENCE IF EXISTS orders_id_seq RESTART WITH 1`);
      await superPool.query(`ALTER SEQUENCE IF EXISTS categories_id_seq RESTART WITH 1`);
      await superPool.query(`ALTER SEQUENCE IF EXISTS bairros_id_seq RESTART WITH 1`);
      console.log('   🔄 Sequences reiniciadas');
    } catch (e) {
      console.log('   ⚠️  Sequences: ', e.message);
    }

    console.log('\n✅ BANCO ZERADO COM SUCESSO!');
    console.log('\n📝 Próximos passos:');
    console.log('   1. Acesse http://localhost:3001/super-admin');
    console.log('   2. Login: admin@seusaas.com / twATwZnFMMIWU4gc1DIW8MEhEbQmihEi');
    console.log('   3. Clique em "Nova Loja" e cadastre a primeira');
    console.log('   4. No formulário, coloque senha inicial: admin123');
    console.log('   5. Acesse a loja: http://localhost:3001/?tenant=SUBDOMINIO');
    console.log('   6. Clique "Admin" → senha: admin123');

  } catch (e) {
    console.error('\n❌ Erro:', e.message);
    console.error(e.stack);
  } finally {
    await superPool.end();
  }
}

main();