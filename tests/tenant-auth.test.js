/* Login real contra um tenant temporário.
   Cria via provisioning, exercita o fluxo de auth e remove tudo no final.
   O cache do tenantResolver é invalidado para não vazar estado entre testes. */
'use strict';

const request = require('supertest');
const crypto = require('crypto');
const { provisionTenant } = require('../services/provisioning');
const { invalidateTenantCache } = require('../middleware/tenantResolver');
const { dbAvailableSync } = require('./setup');

const app = require('../server').app;

const RUN = crypto.randomBytes(4).toString('hex');
const SUBDOMINIO = `jest-${RUN}`;
const EMAIL = `jest-${RUN}@exemplo.com`;
const SENHA = 'SenhaForte123!';

let tenantId = null;

/* Jest resolve describe durante a coleção: a checagem de banco
   precisa ser síncrona (probe em processo filho). */
const DB_UP = dbAvailableSync();

beforeAll(async () => {
  if (!DB_UP) return;

  const criado = await provisionTenant({
    name: 'Loja Jest Temporária',
    subdomain: SUBDOMINIO,
    slug: SUBDOMINIO,
    adminEmail: EMAIL,
    adminPassword: SENHA,
    adminName: 'Admin Jest',
    plan: 'free' // free → trial de 7 dias (tenant resolvível)
  });
  tenantId = criado.tenantId;
});

afterAll(async () => {
  if (!tenantId) return;
  const { Pool } = require('pg');
  const pool = new Pool({
    connectionString: process.env.SUPER_ADMIN_DATABASE_URL || process.env.DATABASE_URL,
    max: 1
  });
  try {
    // Ordem: filhos → pai. Tenant de teste não tem pedidos/produtos.
    await pool.query('DELETE FROM config WHERE tenant_id = $1', [tenantId]);
    await pool.query('DELETE FROM users WHERE tenant_id = $1', [tenantId]);
    await pool.query('DELETE FROM tenants WHERE id = $1', [tenantId]);
  } catch (e) {
    console.error('[test] falha na limpeza do tenant de teste:', e.message);
  } finally {
    await pool.end();
    invalidateTenantCache();
    const fs = require('fs');
    fs.rmSync(require('path').join(__dirname, '..', 'data', 'tenants', tenantId), { recursive: true, force: true });
  }
});

function login(body) {
  return request(app).post(`/api/login?tenant=${SUBDOMINIO}`).send(body);
}

(DB_UP ? describe : describe.skip)('Fluxo de autenticação com tenant real', () => {
  test('login sem senha retorna 400', async () => {
    const res = await login({ email: EMAIL });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/senha/i);
  });

  test('login sem e-mail retorna 400', async () => {
    const res = await login({ password: SENHA });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/e-mail/i);
  });

  test('login com senha errada retorna 401 (não revela qual campo falhou)', async () => {
    const res = await login({ email: EMAIL, password: 'SenhaErrada123' });
    expect(res.status).toBe(401);
    expect(res.body.error).toMatch(/e-mail ou senha incorretos/i);
  });

  test('login com e-mail inexistente retorna 401', async () => {
    const res = await login({ email: `nao-existe-${RUN}@exemplo.com`, password: SENHA });
    expect(res.status).toBe(401);
  });

  test('login correto retorna token, usuário e estado admin', async () => {
    const res = await login({ email: EMAIL, password: SENHA });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(typeof res.body.token).toBe('string');
    expect(res.body.token.length).toBeGreaterThan(20);
    expect(res.body.user.email).toBe(EMAIL);
    expect(res.body.user.role).toBe('admin');
    expect(res.body.tenant.subdomain).toBe(SUBDOMINIO);
    expect(res.body.state).toBeDefined();
  });

  test('resposta de login não expõe o password_hash', async () => {
    const res = await login({ email: EMAIL, password: SENHA });
    expect(JSON.stringify(res.body)).not.toContain('password_hash');
    expect(JSON.stringify(res.body)).not.toContain('scrypt$');
  });

  test('e-mail é case-insensitive no login', async () => {
    const res = await login({ email: EMAIL.toUpperCase(), password: SENHA });
    expect(res.status).toBe(200);
  });

  /* Tenant explícito: sem ele o resultado depende de quantas lojas
     ativas existem no banco (fallback singleActiveTenant), o que tornaria
     o teste instável. */
  test('rota admin exige token (sem token não entra)', async () => {
    const res = await request(app).get(`/api/admin/state?tenant=${SUBDOMINIO}`);
    expect([401, 403]).toContain(res.status);
  });

  test('rota admin aceita o token recebido no login', async () => {
    const loginRes = await login({ email: EMAIL, password: SENHA });
    const token = loginRes.body.token;
    const res = await request(app)
      .get(`/api/admin/state?tenant=${SUBDOMINIO}`)
      .set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.state).toBeDefined();
  });
});
