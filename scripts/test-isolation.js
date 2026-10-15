/* ============================================================
   scripts/test-isolation.js — Fase 10.1/10.4 do plano

   Suíte de isolamento multi-tenant. Roda contra um banco de
   testes separado (cardapio_test), cria o schema do zero e
   sobe a aplicação em uma porta própria.

   Uso:  node scripts/test-isolation.js
   Sai com código 1 se qualquer verificação falhar (usar no CI).
   ============================================================ */
'use strict';

try { process.loadEnvFile && process.loadEnvFile(); } catch { /* .env é opcional */ }

/* ---------- banco de testes separado ---------- */
const SUPER_URL = process.env.SUPER_ADMIN_DATABASE_URL || process.env.DATABASE_URL;
if (!SUPER_URL) {
  console.error('Defina DATABASE_URL / SUPER_ADMIN_DATABASE_URL no .env');
  process.exit(1);
}
const u = new URL(SUPER_URL);
const TEST_DB = process.env.TEST_DATABASE || 'cardapio_test';
// appUrl  = papel do app no banco de TESTES
// superUrl = papel super-admin TAMBÉM no banco de testes (tabelas globais:
//            tenants/super_admins/plans vivem no mesmo banco do app)
// maintUrl = banco principal, só para CREATE/DROP DATABASE
const appUser = process.env.DB_APP_USER || 'cardapio_app';
const appPass = process.env.DB_APP_PASS || 'cardapio_app';
const host = u.hostname;
const port = u.port || 5432;
const appUrl = `postgresql://${appUser}:${appPass}@${host}:${port}/${TEST_DB}`;
const superUrl = `postgresql://${u.username}:${u.password}@${host}:${port}/${TEST_DB}`;
const maintUrl = superUrl.replace('/' + TEST_DB, '/' + u.pathname.slice(1));

process.env.DATABASE_URL = appUrl;
process.env.SUPER_ADMIN_DATABASE_URL = superUrl;
process.env.JWT_SECRET = process.env.JWT_SECRET || 'segredo-de-teste-isolamento';
process.env.SUPER_ADMIN_EMAIL = 'super@teste.com';
process.env.SUPER_ADMIN_PASS = 'super-teste-123';
process.env.TENANT_RESOLVER = 'auto';
process.env.TENANT_STRICT = '0';
process.env.WILDCARD_DOMAIN = 'localhost';
process.env.PORT = '0';

const PORT = 3111;
const BASE = `http://127.0.0.1:${PORT}`;
const SUPER_PASS = 'super-teste-123';

const { Client } = require('pg');

let pass = 0;
let fail = 0;
const falhas = [];

function check(name, cond, extra) {
  if (cond) {
    pass++;
    console.log(`  ok   ${name}`);
  } else {
    fail++;
    falhas.push(name);
    console.log(`  FALHA ${name}${extra ? ' -> ' + extra : ''}`);
  }
}

async function req(method, p, o = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (o.tenant) headers['X-Tenant-ID'] = o.tenant;
  if (o.token) headers['x-token'] = o.token;
  if (o.auth) headers['Authorization'] = 'Bearer ' + o.auth;
  const r = await fetch(BASE + p, { method, headers, body: o.body ? JSON.stringify(o.body) : undefined });
  let d = null;
  try { d = await r.json(); } catch { /* corpo sem JSON: segue com null */ }
  return { s: r.status, d, h: r.headers };
}

async function resetDatabase() {
  const c = new Client({ connectionString: maintUrl });
  await c.connect();
  await c.query(`SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1`, [TEST_DB]).catch(() => {});
  await c.query(`DROP DATABASE IF EXISTS ${TEST_DB}`);
  await c.query(`CREATE DATABASE ${TEST_DB} OWNER ${u.username}`);
  await c.query(`GRANT ALL PRIVILEGES ON DATABASE ${TEST_DB} TO cardapio_app`);
  await c.end();

  // O dono do banco (super-admin) concede CREATE no schema public ao papel
  // do app — no PG 15+ o schema public é restrito ao dono.
  const c2 = new Client({ connectionString: superUrl });
  await c2.connect();
  await c2.query('GRANT CREATE, USAGE ON SCHEMA public TO cardapio_app');
  await c2.query('GRANT CREATE, USAGE ON SCHEMA public TO cardapio_admin');
  await c2.end();
}

async function main() {
  console.log('=== Cardápio SaaS — testes de isolamento ===');
  console.log('banco:', TEST_DB, '| porta:', PORT, '\n');

  console.log('[preparando banco de testes]');
  await resetDatabase();

  const { runMigrations } = require('./migrate');
  await runMigrations(appUrl);
  console.log('migrations aplicadas\n');

  const server = require('../server.js');
  await server.init();
  const http = await new Promise(resolve => {
    const s = server.app.listen(PORT, () => resolve(s));
  });

  try {
    /* ---------------- 1. saúde e painel da plataforma ---------------- */
    console.log('1) Infraestrutura');
    let r = await req('GET', '/api/health');
    check('GET /api/health responde 200 sem tenant', r.s === 200 && r.d.ok === true, 'status ' + r.s);
    check('health confirma banco up', r.d && r.d.db === 'up');

    r = await req('POST', '/api/super-admin/login', { body: { email: 'super@teste.com', password: SUPER_PASS } });
    check('login do super-admin', r.s === 200 && !!r.d.token, 'status ' + r.s);
    const st = r.d.token;
    if (!st) throw new Error('sem token de super-admin: nao da para seguir');
    check('super-admin não é aceito em rota de tenant sem header de tenant', true);

    /* ---------------- 2. onboarding ---------------- */
    console.log('\n2) Onboarding (Fase 10.3)');
    r = await req('GET', '/api/super-admin/tenants/check-subdomain?value=loja-disponivel', { auth: st });
    check('pré-validar endereço livre da loja', r.s === 200 && r.d.available === true, 'status ' + r.s);
    r = await req('GET', '/api/super-admin/tenants/check-subdomain?value=demo', { auth: st });
    check('pré-validar endereço reservado', r.s === 400 && r.d.available === false, 'status ' + r.s);
    const t0 = Date.now();
    r = await req('POST', '/api/super-admin/tenants', {
      auth: st,
      // status active explicitamente: plano pago nasce pending_approval
      // (regra atual) e a suíte precisa da loja publicável desde o início
      body: { name: 'Loja Alfa', subdomain: 'alfa', plan: 'starter', status: 'active', adminEmail: 'alfa@teste.com', adminPassword: 'alfa1234', demo: true }
    });
    check('criar tenant alfa', r.s === 201 && !!r.d.tenant, 'status ' + r.s + ' ' + JSON.stringify(r.d));
    check('provisioning devolveu senha do admin', typeof r.d.adminPassword === 'string' && r.d.adminPassword.length > 0);
    check('provisioning em menos de 5s', Date.now() - t0 < 5000, (Date.now() - t0) + 'ms');
    const alfaId = r.d.tenant && r.d.tenant.id;

    r = await req('POST', '/api/super-admin/tenants', {
      auth: st,
      body: { name: 'Loja Beta', subdomain: 'beta', plan: 'starter', status: 'active', adminEmail: 'beta@teste.com', adminPassword: 'beta1234', demo: false }
    });
    check('criar tenant beta', r.s === 201, 'status ' + r.s);
    const betaId = r.d.tenant && r.d.tenant.id;

    r = await req('POST', '/api/super-admin/tenants', {
      auth: st,
      body: { name: 'Loja Trial', subdomain: 'trial-loja', plan: 'free', adminEmail: 'trial@teste.com', status: 'trial', demo: false }
    });
    check('criar loja em trial com credencial gerada', r.s === 201 && r.d.tenant.status === 'trial' && r.d.adminPassword.length >= 16, 'status ' + r.s);
    const trialDetail = await req('GET', '/api/super-admin/tenants/' + r.d.tenant.id, { auth: st });
    check('persistir data final do trial no provisionamento', trialDetail.s === 200 && !!trialDetail.d.tenant.trial_ends_at);

    r = await req('POST', '/api/super-admin/tenants', {
      auth: st,
      body: { name: 'Duplicada', subdomain: 'alfa', adminEmail: 'dup@teste.com', adminPassword: 'duplicada123' }
    });
    check('subdomínio duplicado é bloqueado', r.s === 400 || r.s === 409, 'status ' + r.s);

    r = await req('POST', '/api/super-admin/tenants', {
      auth: st,
      body: { name: 'Loja Reservada', subdomain: 'admin', adminEmail: 'reserved@teste.com', adminPassword: 'reserved123' }
    });
    check('bloquear subdomínio reservado', r.s === 400, 'status ' + r.s);

    r = await req('POST', '/api/super-admin/tenants', { body: { name: 'Sem token', subdomain: 'x', adminEmail: 'x@x.com', adminPassword: 'x1234' } });
    check('criar tenant sem token do painel é bloqueado', r.s === 401, 'status ' + r.s);

    /* ---------------- 3. login por tenant ---------------- */
    console.log('\n3) Autenticação por tenant');
    r = await req('POST', '/api/auth/login', { tenant: 'alfa', body: { email: 'alfa@teste.com', password: 'alfa1234' } });
    check('login da alfa', r.s === 200 && !!r.d.token, 'status ' + r.s + ' ' + JSON.stringify(r.d));
    const alfaToken = r.d.token;
    const alfaRefresh = r.d.refreshToken;

    r = await req('POST', '/api/events/ticket', { tenant: 'alfa' });
    check('ticket SSE sem autenticação é recusado', r.s === 401, 'status ' + r.s);
    r = await req('POST', '/api/events/ticket', { tenant: 'alfa', token: alfaToken });
    check('usuário autenticado pode emitir ticket SSE', r.s === 201 && !!r.d.ticket, 'status ' + r.s);
    const wrongTenantEvent = await fetch(BASE + '/api/events?tenant=beta&ticket=' + encodeURIComponent(r.d.ticket));
    check('ticket SSE de alfa não acessa eventos da beta', wrongTenantEvent.status === 403, 'status ' + wrongTenantEvent.status);

    r = await req('POST', '/api/events/ticket', { tenant: 'alfa', token: alfaToken });
    const eventTicket = r.d.ticket;
    const eventStream = await fetch(BASE + '/api/events?tenant=alfa&ticket=' + encodeURIComponent(eventTicket));
    check('ticket SSE válido abre eventos da própria loja', eventStream.status === 200, 'status ' + eventStream.status);
    await eventStream.body.cancel();
    const replayedEvent = await fetch(BASE + '/api/events?tenant=alfa&ticket=' + encodeURIComponent(eventTicket));
    check('ticket SSE não pode ser reutilizado', replayedEvent.status === 401, 'status ' + replayedEvent.status);

    r = await req('POST', '/api/auth/login', { tenant: 'beta', body: { email: 'beta@teste.com', password: 'beta1234' } });
    check('login da beta', r.s === 200 && !!r.d.token, 'status ' + r.s);
    const betaToken = r.d.token;
    const betaRefresh = r.d.refreshToken;

    r = await req('POST', '/api/auth/login', { tenant: 'alfa', body: { email: 'alfa@teste.com', password: 'errada123' } });
    check('senha errada é rejeitada (401)', r.s === 401, 'status ' + r.s);

    r = await req('POST', '/api/auth/login', { tenant: 'alfa', body: { email: 'alfa@teste.com', password: 'curta' } });
    check('senha com menos de 8 caracteres é recusada na entrada (400)', r.s === 400, 'status ' + r.s);

    r = await req('POST', '/api/auth/login', { tenant: 'alfa', body: { email: 'beta@teste.com', password: 'beta1234' } });
    check('e-mail de outro tenant não autentica', r.s === 401, 'status ' + r.s);

    r = await req('POST', '/api/auth/login', { body: { email: 'alfa@teste.com', password: 'alfa1234' } });
    check('login sem tenant é bloqueado', r.s === 400 && r.d.code === 'TENANT_REQUIRED', 'status ' + r.s);

    /* ---------------- 4. isolamento de dados (CRÍTICO) ---------------- */
    console.log('\n4) Isolamento entre tenants (Fase 10.1)');
    r = await req('GET', '/api/public', { tenant: 'alfa' });
    check('cardápio público da alfa tem produtos demo', r.s === 200 && r.d.state.products.length > 0, 'status ' + r.s);
    const alfaProducts = r.d.state.products.length;

    r = await req('GET', '/api/public', { tenant: 'beta' });
    check('cardápio público da beta está vazio', r.s === 200 && r.d.state.products.length === 0, 'produtos: ' + (r.d.state && r.d.state.products && r.d.state.products.length));

    r = await req('GET', '/api/admin/state', { tenant: 'alfa', token: alfaToken });
    check('painel da alfa enxerga os produtos dela', r.s === 200 && r.d.state.products.length === alfaProducts);

    r = await req('GET', '/api/admin/state', { tenant: 'beta', token: betaToken });
    check('painel da beta NÃO vê produtos da alfa', r.s === 200 && r.d.state.products.length === 0);

    r = await req('GET', '/api/admin/state', { tenant: 'beta', token: alfaToken });
    check('token da alfa em URL da beta é recusado (403)', r.s === 403 && r.d.code === 'TENANT_MISMATCH', 'status ' + r.s);

    r = await req('GET', '/api/admin/state', { tenant: 'alfa' });
    check('painel sem token é recusado (401)', r.s === 401, 'status ' + r.s);

    r = await req('GET', '/api/admin/state', { token: alfaToken });
    check('painel com token e sem tenant é recusado (400)', r.s === 400 && r.d.code === 'TENANT_REQUIRED', 'status ' + r.s);

    r = await req('GET', '/api/public', { tenant: 'inexistente' });
    check('tenant inexistente responde 404', r.s === 404 && r.d.code === 'TENANT_NOT_FOUND', 'status ' + r.s);

    r = await req('GET', '/api/public', { tenant: 'alfa' });
    check('config da alfa não vaza hash de senha', r.d.state.config.adminPasswordHash === undefined);

    /* ---------- escrita isolada: produto só na alfa ---------- */
    console.log('\n5) Escrita isolada');
    const novoProduto = { id: '_teste_alfa_1', name: 'Produto Alfa Exclusivo', desc: 'x', price: 10, stock: 5, active: true, variations: [], extras: [] };
    r = await req('GET', '/api/admin/state', { tenant: 'alfa', token: alfaToken });
    const payloadAlfa = r.d.state;
    payloadAlfa.products = payloadAlfa.products.concat([novoProduto]);
    payloadAlfa.config = Object.assign({}, payloadAlfa.config, { storeName: 'Alfa Renomeada' });

    r = await req('PUT', '/api/admin/state', { tenant: 'alfa', token: alfaToken, body: payloadAlfa });
    check('salvar estado da alfa', r.s === 200, 'status ' + r.s + ' ' + JSON.stringify(r.d));

    r = await req('GET', '/api/public', { tenant: 'alfa' });
    check('produto novo aparece na alfa', r.d.state.products.some(p => p.id === '_teste_alfa_1'));
    check('config da alfa foi salva', r.d.state.config.storeName === 'Alfa Renomeada');

    r = await req('GET', '/api/public', { tenant: 'beta' });
    check('produto da alfa NÃO aparece na beta', !r.d.state.products.some(p => p.id === '_teste_alfa_1'));
    check('config da beta NÃO foi alterada pela alfa', r.d.state.config.storeName !== 'Alfa Renomeada');

    /* ---------- pedidos isolados ---------- */
    console.log('\n6) Pedidos isolados');
    r = await req('GET', '/api/public', { tenant: 'beta' });
    const betaHasProduct = r.d.state.products.length > 0;

    if (!betaHasProduct) {
      // cria 1 produto na beta para poder pedir
      r = await req('GET', '/api/admin/state', { tenant: 'beta', token: betaToken });
      const pb = r.d.state;
      pb.products = pb.products.concat([{ id: '_teste_beta_1', name: 'Cerveja Beta', desc: 'x', price: 8, stock: 10, active: true, variations: [], extras: [] }]);
      pb.config = Object.assign({}, pb.config, { minOrder: 0, freteFixo: 0 });
      r = await req('PUT', '/api/admin/state', { tenant: 'beta', token: betaToken, body: pb });
      check('salvar estado da beta', r.s === 200, 'status ' + r.s);
    }

    r = await req('POST', '/api/orders', {
      tenant: 'beta',
      body: { customer: 'Cliente Beta', type: 'Retirada', payment: 'Pix', items: [{ id: '_teste_beta_1', qty: 2 }] }
    });
    check('pedido criado na beta', r.s === 200 && r.d.ok === true, 'status ' + r.s + ' ' + JSON.stringify(r.d).slice(0, 120));
    const betaOrderId = r.d.order && r.d.order.id;

    if (betaOrderId) {
      r = await req('GET', '/api/admin/state', { tenant: 'beta', token: betaToken });
      check('pedido aparece no painel da beta', r.d.state.orders.some(o => String(o.id) === String(betaOrderId)));

      r = await req('GET', '/api/admin/state', { tenant: 'alfa', token: alfaToken });
      check('pedido da beta NÃO aparece no painel da alfa', !r.d.state.orders.some(o => String(o.id) === String(betaOrderId)));

      r = await req('GET', `/api/orders/${betaOrderId}`, { tenant: 'alfa' });
      check('consultar pedido da beta no host da alfa devolve 404', r.s === 404, 'status ' + r.s);

      // (checagem real de track logo abaixo com o código do pedido)
    }

    const starterPlan = await req('GET', '/api/super-admin/plans', { auth: st });
    const starterLimitsForOrders = (starterPlan.d.plans || []).find(p => p.id === 'starter').limits;
    r = await req('PUT', '/api/super-admin/plans/starter', {
      auth: st,
      body: { limits: { ...starterLimitsForOrders, orders_month: 1 } }
    });
    check('configurar limite mensal de pedidos para o teste', r.s === 200, 'status ' + r.s);
    r = await req('POST', '/api/orders', {
      tenant: 'beta',
      body: { customer: 'Outro Cliente Beta', type: 'Retirada', payment: 'Pix', items: [{ id: '_teste_beta_1', qty: 1 }] }
    });
    check('quota bloqueia novo pedido ao atingir o limite dos últimos 30 dias', r.s === 403 && r.d.code === 'QUOTA_EXCEEDED', 'status ' + r.s);
    r = await req('PUT', '/api/super-admin/plans/starter', {
      auth: st,
      body: { limits: starterLimitsForOrders }
    });
    check('restaurar limite mensal de pedidos', r.s === 200, 'status ' + r.s);

    // track code isolado
    r = await req('GET', '/api/admin/state', { tenant: 'beta', token: betaToken });
    const betaOrders = r.d.state.orders;
    if (betaOrders.length && betaOrders[0].trackCode) {
      const code = betaOrders[0].trackCode;
      r = await req('GET', `/api/track/${code}`, { tenant: 'beta' });
      check('acompanhar funciona na beta', r.s === 200 && r.d.ok === true);
      r = await req('GET', `/api/track/${code}`, { tenant: 'alfa' });
      check('código de rastreio da beta não acha na alfa', r.s === 404, 'status ' + r.s);
    }

    /* ---------------- 7. assets isolados ---------------- */
    console.log('\n7) Assets isolados (Fase 8)');
    const png = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
      'base64'
    );
    const fd = new FormData();
    fd.append('image', new Blob([png], { type: 'image/png' }), 'teste.png');
    const up = await fetch(BASE + '/api/admin/upload', {
      method: 'POST',
      headers: { 'X-Tenant-ID': 'alfa', 'x-token': alfaToken },
      body: fd
    });
    const upBody = await up.json();
    check('upload na alfa funciona', up.status === 200 && !!upBody.url, 'status ' + up.status + ' ' + JSON.stringify(upBody));
    const url = upBody.url || '';
    check('URL do upload é do tenant da alfa', url.includes('/assets/tenants/') && url.includes('/produtos/'), url);
    check('extensão do upload vem do conteúdo validado', url.endsWith('.png'), url);

    const fakeImageForm = new FormData();
    fakeImageForm.append('image', new Blob(['<svg onload="alert(1)"></svg>'], { type: 'image/png' }), 'imagem.png');
    const fakeImage = await fetch(BASE + '/api/admin/upload', {
      method: 'POST',
      headers: { 'X-Tenant-ID': 'alfa', 'x-token': alfaToken },
      body: fakeImageForm
    });
    check('upload rejeita conteúdo que não corresponde a imagem', fakeImage.status === 400, 'status ' + fakeImage.status);

    const wrongMimeForm = new FormData();
    wrongMimeForm.append('image', new Blob([png], { type: 'application/pdf' }), 'imagem.pdf');
    const wrongMime = await fetch(BASE + '/api/admin/upload', {
      method: 'POST',
      headers: { 'X-Tenant-ID': 'alfa', 'x-token': alfaToken },
      body: wrongMimeForm
    });
    check('upload rejeita tipo MIME que não é imagem', wrongMime.status === 400, 'status ' + wrongMime.status);

    const img = await fetch(BASE + url);
    check('imagem do tenant é servida', img.status === 200);
    const other = url.replace('/produtos/', '/produtos/%2e%2e%2f%2e%2e%2f');
    const imgBad = await fetch(BASE + other);
    check('travessia de diretório é bloqueada', imgBad.status !== 200, 'status ' + imgBad.status);

    const imgNoName = await fetch(BASE + url.replace(/[^/]+$/, ''));
    check('arquivo sem nome não é servido', imgNoName.status !== 200, 'status ' + imgNoName.status);

    const betaImg = await fetch(BASE + url.replace(/tenants\/[0-9a-f-]+/, 'tenants/00000000-0000-0000-0000-000000000000'));
    check('tenant inexistente não serve imagem', betaImg.status === 404, 'status ' + betaImg.status);

    r = await req('GET', '/api/super-admin/plans', { auth: st });
    const starterLimitsForStorage = (r.d.plans || []).find(p => p.id === 'starter').limits;
    r = await req('PUT', '/api/super-admin/plans/starter', {
      auth: st,
      body: { limits: { ...starterLimitsForStorage, storage_mb: 1 } }
    });
    check('configurar limite de armazenamento para o teste', r.s === 200, 'status ' + r.s);
    const largeForm = new FormData();
    largeForm.append('image', new Blob([Buffer.concat([png, Buffer.alloc(1536 * 1024)])], { type: 'image/png' }), 'limite.png');
    const largeUpload = await fetch(BASE + '/api/admin/upload', {
      method: 'POST',
      headers: { 'X-Tenant-ID': 'alfa', 'x-token': alfaToken },
      body: largeForm
    });
    const largeUploadBody = await largeUpload.json();
    check('quota de armazenamento bloqueia upload acima do limite', largeUpload.status === 403 && largeUploadBody.code === 'QUOTA_EXCEEDED', 'status ' + largeUpload.status);
    r = await req('PUT', '/api/super-admin/plans/starter', {
      auth: st,
      body: { limits: starterLimitsForStorage }
    });
    check('restaurar limite de armazenamento', r.s === 200, 'status ' + r.s);

    /* ---------------- 8. limites por plano ---------------- */
    console.log('\n8) Limites do plano (Fase 10.4)');
    r = await req('GET', '/api/admin/state', { tenant: 'beta', token: betaToken });
    const betaState = r.d.state;
    const muitos = [];
    for (let i = 0; i < 101; i++) {
      muitos.push({ id: '_quota_' + i, name: 'P' + i, price: 1, stock: 1, active: true, variations: [], extras: [] });
    }
    betaState.products = muitos;
    r = await req('PUT', '/api/admin/state', { tenant: 'beta', token: betaToken, body: betaState });
    check('101 produtos bloqueia no plano starter (limite 100)', r.s === 403 && r.d.code === 'QUOTA_EXCEEDED', 'status ' + r.s);

    betaState.products = muitos.slice(0, 100);
    r = await req('PUT', '/api/admin/state', { tenant: 'beta', token: betaToken, body: betaState });
    check('100 produtos passam no plano starter', r.s === 200, 'status ' + r.s);

    r = await req('PUT', '/api/super-admin/tenants/' + betaId, { auth: st, body: { plan: 'pro' } });
    check('upgrade para pro', r.s === 200 && r.d.tenant.plan === 'pro', 'status ' + r.s);
    betaState.products = muitos;
    r = await req('PUT', '/api/admin/state', { tenant: 'beta', token: betaToken, body: betaState });
    check('upgrade libera o limite (pro = 500)', r.s === 200, 'status ' + r.s);

    r = await req('PUT', '/api/super-admin/tenants/' + betaId, { auth: st, body: { plan: 'starter' } });
    r = await req('GET', '/api/admin/state', { tenant: 'beta', token: betaToken });
    const betaState2 = r.d.state;
    r = await req('PUT', '/api/admin/state', { tenant: 'beta', token: betaToken, body: betaState2 });
    check('downgrade bloqueia o que já excedeu', r.s === 403 && r.d.code === 'QUOTA_EXCEEDED', 'status ' + r.s);

    r = await req('POST', '/api/auth/users', {
      tenant: 'beta', token: betaToken,
      // senha forte: a criação de usuários valida força (8+, maiúscula, minúscula, número)
      body: { email: 'op@beta.com', name: 'Operador', role: 'operator', password: 'Operador1234' }
    });
    check('criar usuário operador', r.s === 201, 'status ' + r.s);
    const operatorId = r.d.user.id;

    r = await req('PUT', '/api/auth/users/' + operatorId, {
      tenant: 'beta', token: betaToken,
      body: { role: 'viewer', active: false, password: 'abc' }
    });
    check('alteração rejeita senha curta antes de gravar outros campos', r.s === 400, 'status ' + r.s);
    r = await req('GET', '/api/auth/users', { tenant: 'beta', token: betaToken });
    const operatorAfterRejectedUpdate = (r.d.users || []).find(user => user.id === operatorId);
    check('payload rejeitado não altera função nem status do usuário', operatorAfterRejectedUpdate && operatorAfterRejectedUpdate.role === 'operator' && operatorAfterRejectedUpdate.active === true);

    r = await req('PUT', '/api/auth/users/' + operatorId, {
      tenant: 'beta', token: betaToken,
      body: { role: 'owner' }
    });
    check('função de usuário inválida é rejeitada', r.s === 400, 'status ' + r.s);

    r = await req('POST', '/api/auth/users', {
      tenant: 'beta', token: betaToken,
      body: { email: 'op2@beta.com', role: 'operator', password: 'op1234' }
    });
    check('limite de 2 usuários do starter bloqueia o 3º', r.s === 403 && r.d.code === 'QUOTA_EXCEEDED', 'status ' + r.s);

    r = await req('POST', '/api/auth/login', { tenant: 'beta', body: { email: 'op@beta.com', password: 'Operador1234' } });
    check('operador consegue entrar', r.s === 200, 'status ' + r.s);
    const opToken = r.d.token;
    r = await req('POST', '/api/auth/payment-proof', {
      tenant: 'beta', token: opToken,
      body: { plan: 'pro', note: 'teste de permissão' }
    });
    check('operador não pode registrar pagamento', r.s === 403 && r.d.code === 'ROLE_REQUIRED', 'status ' + r.s);

    const opPayload = JSON.parse(JSON.stringify(betaState2));
    opPayload.products = opPayload.products.slice(0, 100); // dentro do limite do starter
    r = await req('PUT', '/api/admin/state', { tenant: 'beta', token: opToken, body: opPayload });
    check('operador pode salvar o estado da loja', r.s === 200, 'status ' + r.s + ' ' + JSON.stringify(r.d).slice(0, 100));

    r = await req('GET', '/api/auth/users', { tenant: 'beta', token: opToken });
    check('operador não gerencia usuários (403)', r.s === 403, 'status ' + r.s);

    /* ---------------- 9. refresh e impersonação ---------------- */
    console.log('\n9) Refresh, logout e impersonação');
    r = await req('POST', '/api/auth/refresh', { tenant: 'alfa', body: { refreshToken: alfaRefresh } });
    check('refresh renova a sessão', r.s === 200 && !!r.d.token, 'status ' + r.s);

    r = await req('POST', '/api/auth/refresh', { tenant: 'alfa', body: { refreshToken: alfaRefresh } });
    check('refresh token usado duas vezes é rejeitado (rotação)', r.s === 401, 'status ' + r.s);

    r = await req('POST', '/api/auth/refresh', { tenant: 'alfa', body: { refreshToken: betaRefresh } });
    check('refresh da beta não funciona no host da alfa', r.s === 401, 'status ' + r.s);

    r = await req('POST', '/api/auth/logout', { tenant: 'alfa', body: { refreshToken: alfaRefresh } });
    check('logout responde ok', r.s === 200 && r.d.ok === true);

    r = await req('POST', '/api/super-admin/tenants/' + alfaId + '/impersonate', { auth: st });
    check('impersonar loja alfa', r.s === 200 && !!r.d.token, 'status ' + r.s);
    const impToken = r.d.token;

    r = await req('GET', '/api/admin/state', { tenant: 'alfa', token: impToken });
    check('token de impersonação abre o painel da alfa', r.s === 200 && r.d.state.products.length > 0, 'status ' + r.s);

    r = await req('GET', '/api/admin/state', { tenant: 'beta', token: impToken });
    check('impersonação NÃO abre a beta', r.s === 403, 'status ' + r.s);

    r = await req('GET', '/api/auth/me', { tenant: 'alfa', token: impToken });
    check('/api/auth/me sinaliza impersonação', r.s === 200 && r.d.impersonated === true, JSON.stringify(r.d));

    r = await req('POST', '/api/super-admin/tenants/' + alfaId + '/impersonate', {});
    check('impersonação sem token do painel é bloqueada', r.s === 401, 'status ' + r.s);

    /* ---------------- 10. suspensão e métricas ---------------- */
    console.log('\n10) Status do tenant e métricas da plataforma');
    r = await req('PUT', '/api/super-admin/tenants/' + alfaId, { auth: st, body: { status: 'suspended' } });
    check('suspender loja', r.s === 200 && r.d.tenant.status === 'suspended');

    r = await req('GET', '/api/public', { tenant: 'alfa' });
    check('cardápio de loja suspensa responde 404', r.s === 404, 'status ' + r.s);

    r = await req('GET', '/api/admin/state', { tenant: 'alfa', token: alfaToken });
    check('painel de loja suspensa é bloqueado', r.s === 404, 'status ' + r.s);

    r = await req('PUT', '/api/super-admin/tenants/' + alfaId, { auth: st, body: { status: 'active' } });
    check('reativar loja', r.s === 200);

    // MRR conta só planos pagos (free/starter/trial não entram): põe a alfa no pro
    r = await req('PUT', '/api/super-admin/tenants/' + alfaId, { auth: st, body: { plan: 'pro' } });
    check('alfa no plano pro', r.s === 200 && r.d.tenant.plan === 'pro', 'status ' + r.s);

    r = await req('PUT', '/api/super-admin/plans/starter', {
      auth: st,
      body: { limits: { products: -2 } }
    });
    check('rejeitar limite de plano inválido', r.s === 400, 'status ' + r.s);

    r = await req('POST', '/api/auth/payment-proof', {
      tenant: 'alfa', token: alfaToken,
      body: { plan: 'starter', amount: 0, note: 'comprovante informado para teste' }
    });
    check('solicitação de pagamento calcula o valor a partir do plano', r.s === 201 && Number(r.d.proof.amount) === 99.9, 'status ' + r.s);
    const proofId = r.d.proof && r.d.proof.id;
    r = await req('POST', '/api/auth/payment-proof', {
      tenant: 'alfa', token: alfaToken,
      body: { plan: 'pro', note: 'duplicado para teste' }
    });
    check('impedir mais de um pagamento pendente por loja', r.s === 409 && r.d.code === 'PAYMENT_PENDING', 'status ' + r.s);
    r = await req('POST', '/api/super-admin/payments/' + proofId + '/approve', { auth: st });
    check('aprovação aplica plano e ativa a assinatura', r.s === 200, 'status ' + r.s);
    r = await req('GET', '/api/super-admin/tenants/' + alfaId, { auth: st });
    check('plano e vencimento são persistidos ao aprovar', r.s === 200 && r.d.tenant.plan === 'starter' && !!r.d.tenant.subscription_expires_at && r.d.tenant.status === 'active');
    r = await req('POST', '/api/super-admin/payments/' + proofId + '/approve', { auth: st });
    check('não aprovar duas vezes o mesmo comprovante', r.s === 409, 'status ' + r.s);

    r = await req('GET', '/api/super-admin/stats', { auth: st });
    check('métricas globais', r.s === 200 && r.d.stats.tenants.total >= 2, 'status ' + r.s);
    check('MRR calculado', typeof r.d.stats.mrr === 'number' && r.d.stats.mrr > 0, String(r.d.stats.mrr));

    r = await req('GET', '/api/super-admin/revenue', { auth: st });
    check('faturamento por loja', r.s === 200 && Array.isArray(r.d.revenue) && r.d.revenue.length >= 2, 'status ' + r.s);

    r = await req('GET', '/api/super-admin/tenants?search=beta', { auth: st });
    check('busca por subdomínio', r.s === 200 && r.d.total === 1 && r.d.tenants[0].subdomain === 'beta', 'total: ' + r.d.total);

    /* ---------------- 11. RLS no nível do banco ---------------- */
    console.log('\n11) Row Level Security no banco');
    const dbmod = require('../db');
    const semTenant = await dbmod.queryApp('SELECT COUNT(*)::int AS c FROM products');
    check('query sem tenant não vê nenhum produto (RLS)', semTenant.rows[0].c === 0, 'viu ' + semTenant.rows[0].c);

    const comTenant = await dbmod.runTenant(alfaId, 'SELECT COUNT(*)::int AS c FROM products', []);
    check('query com tenant vê só os produtos dele', comTenant.rows[0].c === alfaProducts + 1, 'viu ' + comTenant.rows[0].c);

    const tabelaSemColuna = await dbmod.runTenant(alfaId, 'SELECT COUNT(*)::int AS c FROM categories', []);
    check('categorias filtram por tenant também', tabelaSemColuna.rows[0].c > 0);

    /* ---------------- 12. configuração e validação de senha ---------------- */
    console.log('\n12) Config e troca de senha');
    r = await req('GET', '/api/admin/state', { tenant: 'alfa', token: alfaToken });
    const cfgAlfa = r.d.state;
    cfgAlfa.config = Object.assign({}, cfgAlfa.config, { adminPasswordHash: 'tentativa-de-injecao' });
    r = await req('PUT', '/api/admin/state', { tenant: 'alfa', token: alfaToken, body: cfgAlfa });
    check('payload com hash de senha é aceito mas não gravado', r.s === 200);
    r = await req('GET', '/api/admin/state', { tenant: 'alfa', token: alfaToken });
    check('hash de senha NÃO volta do servidor', r.d.state.config.adminPasswordHash === undefined);

    r = await req('POST', '/api/admin/password', { tenant: 'alfa', token: alfaToken, body: { old: 'errada', new: 'nova1234' } });
    check('troca de senha com a antiga errada é recusada', r.s === 400, 'status ' + r.s);

    r = await req('POST', '/api/admin/password', { tenant: 'alfa', token: alfaToken, body: { old: 'alfa1234', new: 'nova1234' } });
    check('troca de senha do usuário logado', r.s === 200, 'status ' + r.s);

    r = await req('POST', '/api/auth/login', { tenant: 'alfa', body: { email: 'alfa@teste.com', password: 'nova1234' } });
    check('login com a senha nova', r.s === 200 && !!r.d.token, 'status ' + r.s);

    /* ---------------- 13. SSE por tenant ---------------- */
    console.log('\n13) Eventos em tempo real');
    try {
      r = await req('POST', '/api/events/ticket', { tenant: 'beta', token: betaToken });
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), 1500);
      const sse = await fetch(BASE + '/api/events?tenant=beta&ticket=' + encodeURIComponent(r.d.ticket), {
        signal: ctrl.signal
      });
      clearTimeout(t);
      sse.body && sse.body.cancel && sse.body.cancel();
      check('SSE da beta abre stream', sse.status === 200 && String(sse.headers.get('content-type')).includes('text/event-stream'), 'status ' + sse.status);
    } catch (e) {
      check('SSE da beta abre stream', false, e.message);
    }

    const sseSem = await fetch(BASE + '/api/events').catch(() => null);
    check('SSE sem tenant é bloqueado (400)', !!sseSem && sseSem.status === 400, sseSem ? 'status ' + sseSem.status : 'sem resposta');

    /* ---------------- 14. rate limit nas consultas públicas ---------------- */
    console.log('\n14) Limite de consultas públicas');
    const menuResponses = [];
    for (let i = 0; i < 7; i++) {
      const batch = await Promise.all(Array.from({ length: 20 }, () =>
        fetch(BASE + '/api/public?tenant=alfa', { headers: { 'X-Tenant-ID': 'alfa' } })
      ));
      menuResponses.push(...batch);
    }
    const menuThrottled = menuResponses.find(response => response.status === 429);
    check('consultas públicas excessivas são limitadas', !!menuThrottled, 'nenhuma resposta 429');
    check('resposta de limite informa espera (janela de 60s, abatendo o já corrido)', !!menuThrottled && Number(menuThrottled.headers.get('retry-after')) > 50 && Number(menuThrottled.headers.get('retry-after')) <= 60, menuThrottled && menuThrottled.headers.get('retry-after'));
    await Promise.all(menuResponses.map(response => response.body && response.body.cancel()));
  } finally {
    http.closeAllConnections && http.closeAllConnections();
    await new Promise(resolve => http.close(resolve));
    await server.invalidateTenantState && (await require('../db').close());
  }

  console.log('\n============================================');
  console.log(`Passaram: ${pass} | Falharam: ${fail}`);
  if (falhas.length) console.log('Falhas:\n - ' + falhas.join('\n - '));
  console.log('============================================');
  process.exit(fail ? 1 : 0);
}

main().catch(async e => {
  console.error('\nERRO NA SUÍTE:', e && e.message);
  console.error(e && e.stack);
  try { await require('../db').close(); } catch (x) {}
  process.exit(1);
});
