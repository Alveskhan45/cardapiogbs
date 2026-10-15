/* Testes do log estruturado e das métricas em memória. */
'use strict';

const logger = require('../lib/logger');
const metrics = require('../lib/metrics');

const CAPTURE = [];
let origLog, origWarn, origError;

beforeEach(() => {
  CAPTURE.length = 0;
  origLog = console.log;
  origWarn = console.warn;
  origError = console.error;
  console.log = (l) => CAPTURE.push({ stream: 'out', line: l });
  console.warn = (l) => CAPTURE.push({ stream: 'warn', line: l });
  console.error = (l) => CAPTURE.push({ stream: 'err', line: l });
  metrics.reset();
});

afterEach(() => {
  console.log = origLog;
  console.warn = origWarn;
  console.error = origError;
});

function parsed() {
  return CAPTURE.map(c => ({ ...c, body: JSON.parse(c.line) }));
}

describe('logger: formato', () => {
  test('cada evento é uma linha JSON com ts/level/event', () => {
    logger.info('evento_teste', { a: 1 });
    const rows = parsed();
    expect(rows).toHaveLength(1);
    expect(rows[0].body.level).toBe('info');
    expect(rows[0].body.event).toBe('evento_teste');
    expect(rows[0].body.a).toBe(1);
    expect(Date.parse(rows[0].body.ts)).toBeGreaterThan(0);
  });

  test('warn vai para stderr, info para stdout', () => {
    logger.warn('algo_estranho', {});
    logger.info('normal', {});
    const rows = parsed();
    expect(rows.find(r => r.body.event === 'algo_estranho').stream).toBe('warn');
    expect(rows.find(r => r.body.event === 'normal').stream).toBe('out');
  });

  test('erro serializa Error com mensagem e nome (sem stack em nível info)', () => {
    const prev = process.env.LOG_LEVEL;
    process.env.LOG_LEVEL = 'info';
    try {
      logger.error('falhou', new Error('banco caiu'));
    } finally {
      if (prev === undefined) delete process.env.LOG_LEVEL;
      else process.env.LOG_LEVEL = prev;
    }
    const row = parsed()[0];
    expect(row.stream).toBe('err');
    expect(row.body.message).toBe('banco caiu');
    expect(row.body.error_name).toBe('Error');
    expect(row.body.stack).toBeUndefined();
  });

  test('serializa BigInt e objetos circulares sem estourar', () => {
    const circular = { nome: 'x' };
    circular.eu = circular;
    logger.info('bizarro', { grande: 9007199254740993n, circular });
    const row = parsed()[0];
    expect(row.body.grande).toBe('9007199254740993');
    expect(row.body.circular.eu).toBe('[circular]');
  });
});

describe('logger: redação de segredos', () => {
  test('redaz chaves sensíveis conhecidas', () => {
    logger.info('login', { password: 'senha123', token: 'abc123', authorization: 'Bearer x' });
    const row = parsed()[0].body;
    expect(row.password).not.toBe('senha123');
    expect(row.token).not.toBe('abc123');
    expect(row.authorization).not.toBe('Bearer x');
  });

  test('redação é RECURSIVA (objeto aninhado)', () => {
    logger.info('payload', { body: { user: { passwordHash: 'segredo', email: 'a@b.com' } } });
    const row = parsed()[0].body;
    expect(row.body.user.passwordHash).not.toBe('segredo');
    expect(row.body.user.email).toBe('a@b.com');
  });

  test('redaction case/underscore-insensitive: password_hash e passwordHash', () => {
    logger.info('u', { password_hash: 'x', passwordHash: 'y', PASSWORD: 'z' });
    const row = parsed()[0].body;
    [row.password_hash, row.passwordHash, row.PASSWORD].forEach(v => expect(v).not.toMatch(/^(x|y|z)$/));
  });

  test('campos de correlação (request_id) NÃO são redazados', () => {
    logger.info('r', { request_id: 'abc-123', route: 'GET /api/health', status: 500 });
    const row = parsed()[0].body;
    expect(row.request_id).toBe('abc-123');
    expect(row.route).toBe('GET /api/health');
    expect(row.status).toBe(500);
  });

  test('arrays são percorridos', () => {
    logger.info('lote', { itens: [{ token: 't' }, { ok: 1 }] });
    const row = parsed()[0].body;
    expect(row.itens[0].token).not.toBe('t');
    expect(row.itens[1].ok).toBe(1);
  });
});

describe('logger: nível', () => {
  test('LOG_LEVEL=error silencia info/warn', () => {
    const prev = process.env.LOG_LEVEL;
    process.env.LOG_LEVEL = 'error';
    try {
      logger.info('nao_deve_sair', {});
      logger.warn('tambem_nao', {});
      logger.error('este_sai', {});
      const events = parsed().map(r => r.body.event);
      expect(events).toEqual(['este_sai']);
    } finally {
      if (prev === undefined) delete process.env.LOG_LEVEL;
      else process.env.LOG_LEVEL = prev;
    }
  });

  test('LOG_LEVEL=debug libera o stack do erro', () => {
    const prev = process.env.LOG_LEVEL;
    process.env.LOG_LEVEL = 'debug';
    try {
      logger.error('com_stack', new Error('falha'));
      expect(parsed()[0].body.stack).toContain('Error: falha');
    } finally {
      if (prev === undefined) delete process.env.LOG_LEVEL;
      else process.env.LOG_LEVEL = prev;
    }
  });
});

describe('logger: routeError (contexto de request)', () => {
  test('erro de rota sai com request_id, tenant, rota e método', () => {
    const req = {
      method: 'PUT',
      path: '/api/admin/state',
      requestId: 'req-777',
      tenantId: 'uuid-1',
      tenant: { subdomain: 'loja-x' }
    };
    logger.routeError(req, '/api/admin/state', new Error('estourou o pool'));
    const row = parsed()[0].body;
    expect(row.event).toBe('http_error');
    expect(row.level).toBe('error');
    expect(row.route).toBe('/api/admin/state');
    expect(row.method).toBe('PUT');
    expect(row.request_id).toBe('req-777');
    expect(row.tenant_id).toBe('uuid-1');
    expect(row.tenant).toBe('loja-x');
    expect(row.message).toBe('estourou o pool');
  });

  test('aceita string fora de Error', () => {
    logger.routeError({ method: 'GET', path: '/x' }, 'GET /x', 'falhou feio');
    expect(parsed()[0].body.message).toBe('falhou feio');
  });
});

describe('logger: classificação de status', () => {
  test('5xx vira erro, 4xx warn, 2xx info', () => {
    const mk = (status) => ({ statusCode: status, on: () => {} });
    logger.request({ method: 'GET', originalUrl: '/api/x' }, mk(500), Date.now());
    logger.request({ method: 'GET', originalUrl: '/api/x' }, mk(404), Date.now());
    logger.request({ method: 'GET', originalUrl: '/api/x' }, mk(200), Date.now());
    const rows = parsed().map(r => r.body);
    expect(rows[0].level).toBe('error');
    expect(rows[0].status_class).toBe('5xx');
    expect(rows[1].level).toBe('warn');
    expect(rows[2].level).toBe('info');
    expect(rows[2].route).toBe('GET /api/x');
  });

  test('rota sem query string e sem vazar query', () => {
    logger.request({ method: 'POST', originalUrl: '/api/track?code=1234' }, { statusCode: 200, on: () => {} }, Date.now());
    const row = parsed()[0].body;
    expect(row.path).toBe('/api/track');
    expect(row.route).toBe('POST /api/track');
  });
});

describe('métricas expostas no painel', () => {
  const request = require('supertest');
  const app = require('../server').app;
  const db = require('../db');
  const { hashPass } = require('../lib/passwords');
  const crypto = require('crypto');

  let superAdminId = null;
  let token = null;

  beforeAll(async () => {
    const email = `metrics-${crypto.randomBytes(4).toString('hex')}@plataforma.com`;
    const sa = await db.runSuper(
      `INSERT INTO super_admins (email, password_hash, name, active)
       VALUES ($1, $2, 'Super Admin de Teste', TRUE)
       RETURNING id`,
      [email, hashPass('SenhaForte123')]
    );
    superAdminId = sa.rows[0].id;
    const login = await request(app).post('/api/super-admin/login').send({ email, password: 'SenhaForte123' });
    token = login.body.token;
  });

  afterAll(async () => {
    if (!superAdminId) return;
    await db.runSuper('DELETE FROM super_admins WHERE id = $1', [superAdminId]).catch(() => {});
  });

  test('GET /api/super-admin/runtime devolve métricas do processo', async () => {
    // o middleware observa no finish: uma request antes de medir
    await request(app).get('/api/health');
    const res = await request(app)
      .get('/api/super-admin/runtime')
      .set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.runtime.requests_total).toBeGreaterThan(0);
    expect(res.body.runtime.latency_ms.p95).toBeGreaterThanOrEqual(0);
    expect(Array.isArray(res.body.runtime.top_routes)).toBe(true);
    expect(res.body.runtime.top_routes.some(r => r.route.includes('/api/health'))).toBe(true);
    expect(res.body.node.version).toMatch(/^v\d+/);
    expect(res.body.node.memory_rss_mb).toBeGreaterThan(0);
  });

  test('GET /api/super-admin/runtime exige token do painel', async () => {
    const res = await request(app).get('/api/super-admin/runtime');
    expect([401, 403]).toContain(res.status);
  });
});

describe('metrics: coleta em memória', () => {
  test('conta requests, erros e classes de status', () => {
    metrics.observe({ status: 200, route: 'GET /a', duration_ms: 10 });
    metrics.observe({ status: 500, route: 'GET /a', duration_ms: 90 });
    metrics.observe({ status: 404, route: 'GET /b', duration_ms: 20, error: false });
    const s = metrics.snapshot();
    expect(s.requests_total).toBe(3);
    expect(s.errors_5xx_total).toBe(1);
    expect(s.by_status_class['2xx']).toBe(1);
    expect(s.by_status_class['5xx']).toBe(1);
    expect(s.error_rate_pct).toBeCloseTo(33.33, 1);
  });

  test('percentis usam nearest-rank sobre as amostras ordenadas', () => {
    for (let i = 1; i <= 100; i++) metrics.observe({ status: 200, route: 'r', duration_ms: i });
    const s = metrics.snapshot();
    // nearest-rank: índice = ceil(p/100 * N) -> 1-based
    expect(s.latency_ms.p50).toBe(50);
    expect(s.latency_ms.p95).toBe(95);
    expect(s.latency_ms.p99).toBe(99);
    expect(s.latency_ms.samples).toBe(100);
  });

  test('uma única amostra: todos os percentis iguais a ela', () => {
    metrics.observe({ status: 200, route: 'r', duration_ms: 42 });
    const s = metrics.snapshot();
    expect(s.latency_ms.p50).toBe(42);
    expect(s.latency_ms.p99).toBe(42);
  });

  test('agrega por rota com contagem e média', () => {
    metrics.observe({ status: 200, route: 'GET /a', duration_ms: 10 });
    metrics.observe({ status: 200, route: 'GET /a', duration_ms: 30 });
    metrics.observe({ status: 500, route: 'GET /b', duration_ms: 5, error: true });
    const s = metrics.snapshot();
    const a = s.top_routes.find(r => r.route === 'GET /a');
    expect(a.count).toBe(2);
    expect(a.avg_ms).toBe(20);
    expect(s.top_routes.find(r => r.route === 'GET /b').errors).toBe(1);
  });

  test('janela deslizante não cresce sem limite', () => {
    for (let i = 0; i < 2500; i++) metrics.observe({ status: 200, route: 'r', duration_ms: 1 });
    expect(metrics.snapshot().latency_ms.samples).toBe(2000);
  });

  test('reset zera tudo', () => {
    metrics.observe({ status: 500, route: 'r', duration_ms: 1, error: true });
    metrics.reset();
    const s = metrics.snapshot();
    expect(s.requests_total).toBe(0);
    expect(s.errors_5xx_total).toBe(0);
    expect(s.top_routes).toEqual([]);
  });

  test('snapshot sem requisições não divide por zero', () => {
    const s = metrics.snapshot();
    expect(s.error_rate_pct).toBe(0);
    expect(s.latency_ms.p95).toBe(0);
  });
});
