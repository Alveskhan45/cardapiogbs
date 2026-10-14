/* ============================================================
   services/provisioning.js — criação de tenants (Fase 6.3)

  provisionTenant roda em UMA transação no pool super-admin:
   tenant + admin user + config padrão (+ dados demo) + pasta
   de assets isolada. Se qualquer passo falhar, nada é criado.
   ============================================================ */
'use strict';

const fs = require('fs');
const path = require('path');
const { v4: uuidv4 } = require('uuid');
const db = require('../db');
const { hashPass, generatePassword } = require('../lib/passwords');
const { defaultConfig, demoState } = require('../lib/seed');

const DATA_DIR = path.join(__dirname, '..', 'data');
const TENANTS_DIR = path.join(DATA_DIR, 'tenants');

const SUBDOMAIN_RE = /^[a-z0-9](?:[a-z0-9-]{0,97}[a-z0-9])$/;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const RESERVED_SUBDOMAINS = new Set([
  'admin', 'api', 'app', 'assets', 'billing', 'demo', 'help', 'login',
  'mail', 'panel', 'root', 'saas', 'support', 'www'
]);

function slugify(s) {
  return String(s || '')
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 100);
}

function validate(data) {
  const errors = [];
  const name = String(data.name || '').trim();
  if (!name) errors.push('Nome do tenant é obrigatório');
  if (name.length > 200) errors.push('Nome muito longo (máx. 200)');

  const subdomain = String(data.subdomain || slugify(name)).trim().toLowerCase();
  if (!SUBDOMAIN_RE.test(subdomain)) {
    errors.push('Subdomínio inválido (use apenas letras minúsculas, números e hífen; 2-100 chars)');
  } else if (RESERVED_SUBDOMAINS.has(subdomain)) {
    errors.push('Este subdomínio é reservado pela plataforma');
  }

  const slug = String(data.slug || subdomain).trim().toLowerCase();
  if (!SUBDOMAIN_RE.test(slug)) errors.push('Slug inválido');
  else if (RESERVED_SUBDOMAINS.has(slug)) errors.push('Este slug é reservado pela plataforma');

  const adminEmail = String(data.adminEmail || '').trim().toLowerCase();
  if (!EMAIL_RE.test(adminEmail)) errors.push('E-mail do admin inválido');
  if (adminEmail.length > 254) errors.push('E-mail do admin muito longo');

  const plan = String(data.plan || 'starter').trim().toLowerCase();
  if (!['free', 'starter', 'pro'].includes(plan)) errors.push('Plano inválido');
  
  /* Status inicial baseado no plano:
     - free: trial de 7 dias
     - starter/pro: pending_approval (aguarda super-admin aprovar pagamento) */
  let status = String(data.status || '').trim().toLowerCase();
  if (!status) {
    status = plan === 'free' ? 'trial' : 'pending_approval';
  }
  if (!['active', 'trial', 'pending_approval', 'suspended', 'cancelled'].includes(status)) {
    errors.push('Status inicial inválido');
  }
  const adminPassword = String(data.adminPassword || '').trim();
  if (adminPassword && (adminPassword.length < 8 || adminPassword.length > 128)) {
    errors.push('A senha inicial deve ter entre 8 e 128 caracteres');
  }
  const phone = String(data.phone || '').trim();
  if (phone.length > 30) errors.push('Telefone muito longo (máx. 30 caracteres)');
  const cnpj = String(data.cnpj || '').trim();
  if (cnpj.length > 30) errors.push('Razão social/CNPJ muito longo (máx. 30 caracteres)');
  const address = String(data.address || '').trim();
  if (address.length > 300) errors.push('Endereço muito longo (máx. 300 caracteres)');
  const primaryColor = String(data.primaryColor || '').trim();
  if (primaryColor && !/^#[0-9a-f]{6}$/i.test(primaryColor)) errors.push('Cor primária inválida');

  const values = {
    name,
    subdomain,
    slug,
    adminEmail,
    plan,
    adminName: String(data.adminName || '').trim().slice(0, 200),
    adminPassword,
    status,
    phone,
    cnpj,
    address,
    primaryColor
  };

  return { values, errors };
}

function tenantAssetDir(tenantId) {
  return path.join(TENANTS_DIR, tenantId, 'produtos');
}

async function provisionTenant(data) {
  const { values: v, errors } = validate(data || {});
  if (errors.length) throw provisioningError(errors.join(' | '));

  const adminPassword = v.adminPassword || generatePassword(16);
  const tenantId = uuidv4();
  const wantDemo = data.demo === true;
  
  /* Trial de 7 dias para plano free, 14 dias para trial explícito */
  const trialEndsAt = v.status === 'trial'
    ? new Date(Date.now() + (v.plan === 'free' ? 7 : 14) * 24 * 60 * 60 * 1000)
    : (v.plan === 'free' ? new Date(Date.now() + 7 * 24 * 60 * 60 * 1000) : null);

  const planCheck = await db.runSuper('SELECT id FROM plans WHERE id = $1', [v.plan]);
  if (!planCheck.rows.length) throw provisioningError('Plano não existe: ' + v.plan);

  const dup = await db.runSuper(
    'SELECT id FROM tenants WHERE subdomain = $1 OR slug = $2 LIMIT 1',
    [v.subdomain, v.slug]
  );
  if (dup.rows.length) throw provisioningError('Subdomínio/slug já existe');

  const tenantDir = path.join(TENANTS_DIR, tenantId);
  fs.mkdirSync(path.join(tenantDir, 'produtos'), { recursive: true });
  fs.mkdirSync(path.join(tenantDir, 'backups'), { recursive: true });
  fs.mkdirSync(path.join(tenantDir, 'exports'), { recursive: true });

  try {
    await db.withSuperTransaction(async ctx => {
      await ctx.q(
        `INSERT INTO tenants
           (id, name, subdomain, slug, plan, status, settings, cnpj, phone, address, primary_color, trial_ends_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
        [tenantId, v.name, v.subdomain, v.slug, v.plan, v.status, data.settings || {},
          v.cnpj, v.phone, v.address, v.primaryColor, trialEndsAt]
      );

      await ctx.q(
        `INSERT INTO users (id, tenant_id, email, password_hash, name, role, active)
         VALUES ($1, $2, $3, $4, $5, 'admin', TRUE)`,
        [uuidv4(), tenantId, v.adminEmail, hashPass(adminPassword), v.adminName || v.name]
      );

      const overrides = { storeName: v.name };
      if (data.slogan) overrides.slogan = String(data.slogan).slice(0, 300);
      const cfg = defaultConfig(overrides);
      for (const [key, value] of Object.entries(cfg)) {
        if (value === undefined) continue;
        await ctx.q('INSERT INTO config (tenant_id, key, value) VALUES ($1, $2, $3)', [tenantId, key, JSON.stringify(value)]);
      }

      if (wantDemo) {
        const demo = demoState(v.name);
        for (const p of demo.products) {
          await ctx.q('INSERT INTO products (tenant_id, id, data) VALUES ($1, $2, $3)', [tenantId, String(p.id), p]);
        }
        for (const c of demo.coupons) {
          await ctx.q('INSERT INTO coupons (tenant_id, id, data) VALUES ($1, $2, $3)', [tenantId, String(c.id), c]);
        }
        for (const b of demo.bairros) {
          await ctx.q('INSERT INTO bairros (tenant_id, id, data) VALUES ($1, $2, $3)', [tenantId, String(b.id), b]);
        }
        for (const name of demo.categories) {
          await ctx.q('INSERT INTO categories (tenant_id, name) VALUES ($1, $2)', [tenantId, name]);
        }
      }
    });
  } catch (error) {
    fs.rmSync(tenantDir, { recursive: true, force: true });
    throw error;
  }

  return {
    tenantId,
    tenant: {
      id: tenantId, name: v.name, subdomain: v.subdomain, slug: v.slug,
      plan: v.plan, status: v.status, trial_ends_at: trialEndsAt,
      cnpj: v.cnpj, phone: v.phone, address: v.address, primary_color: v.primaryColor
    },
    adminEmail: v.adminEmail,
    adminPassword,
    demo: wantDemo
  };
}

function provisioningError(message, code = 'TENANT_INVALID') {
  const e = new Error(message);
  e.code = code;
  return e;
}

module.exports = { provisionTenant, provisioningError, tenantAssetDir, slugify, validate, TENANTS_DIR, DATA_DIR };
