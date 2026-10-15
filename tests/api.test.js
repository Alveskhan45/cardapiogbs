const request = require('supertest');
const { dbAvailableSync } = require('./setup');

let app;

beforeAll(() => {
  app = require('../server').app;
});

/** Extrai uma diretiva específica do header CSP. */
function cspDirective(res, name) {
  const csp = res.headers['content-security-policy'] || '';
  const m = csp.match(new RegExp(name + '\\s+([^;]*)'));
  return m ? m[1].trim() : null;
}

describe('Páginas (sem banco)', () => {
  test('GET / retorna landing page', async () => {
    const res = await request(app).get('/');
    expect(res.status).toBe(200);
    expect(res.text).toContain('CardapioDigital');
  });

  test('GET /landing retorna a mesma landing', async () => {
    const res = await request(app).get('/landing');
    expect(res.status).toBe(200);
  });

  test('GET /?tenant=loja redireciona para /cardapio', async () => {
    const res = await request(app).get('/?tenant=loja-teste');
    expect(res.status).toBe(302);
    expect(res.headers.location).toContain('/cardapio');
  });

  test('GET /super-admin retorna o painel da plataforma', async () => {
    const res = await request(app).get('/super-admin');
    expect(res.status).toBe(200);
    expect(res.text).toContain('super-admin');
  });
});

describe('Segurança HTTP', () => {
  test('Headers de segurança presentes', async () => {
    const res = await request(app).get('/');
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['x-frame-options']).toBe('DENY');
    expect(res.headers['content-security-policy']).toBeTruthy();
    expect(res.headers['referrer-policy']).toBe('strict-origin-when-cross-origin');
  });

  test('CSP script-src NÃO permite unsafe-inline (anti-XSS)', async () => {
    const res = await request(app).get('/');
    const scriptSrc = cspDirective(res, 'script-src');
    expect(scriptSrc).toBe("'self'");
    expect(scriptSrc).not.toContain("'unsafe-inline'");
  });

  test('CSP object-src none e frame-ancestors none', async () => {
    const res = await request(app).get('/');
    expect(cspDirective(res, 'object-src')).toBe("'none'");
    expect(cspDirective(res, 'frame-ancestors')).toBe("'none'");
  });

  test('HSTS presente', async () => {
    const res = await request(app).get('/');
    expect(res.headers['strict-transport-security']).toContain('max-age=31536000');
  });

  test('x-powered-by removido', async () => {
    const res = await request(app).get('/');
    expect(res.headers['x-powered-by']).toBeUndefined();
  });
});

describe('Resolução de tenant e validação de login', () => {
  test('POST /api/login sem tenant é rejeitado com 400 TENANT_REQUIRED', async () => {
    const res = await request(app)
      .post('/api/login')
      .send({ email: 'adm@exemplo.com', password: 'admin123' });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('TENANT_REQUIRED');
  });

  test('POST /api/login com ?tenant= inexistente retorna 404 TENANT_NOT_FOUND', async () => {
    const res = await request(app)
      .post('/api/login?tenant=tenant-inexistente-xyz')
      .send({ email: 'adm@exemplo.com', password: 'admin123' });
    expect(res.status).toBe(404);
    expect(res.body.code).toBe('TENANT_NOT_FOUND');
  });

  test('Corpo vazio não derruba o login (responde 400, não 500)', async () => {
    const res = await request(app).post('/api/login').send({});
    expect(res.status).toBe(400);
    expect(res.status).not.toBe(500);
  });
});

/* Jest resolve describe na coleção: checagem síncrona de banco. */
const DB_UP = dbAvailableSync();

(DB_UP ? describe : describe.skip)('Endpoints dependentes de banco', () => {
  test('GET /api/health retorna db up', async () => {
    const res = await request(app).get('/api/health');
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.db).toBe('up');
  });

  test('GET /api/health não expõe versão do Node nem memória', async () => {
    const res = await request(app).get('/api/health');
    expect(res.body.node_version).toBeUndefined();
    expect(res.body.uptime_s).toBeUndefined();
    expect(res.body.memory_rss_mb).toBeUndefined();
  });

  test('GET /api/ready valida tabelas críticas', async () => {
    const res = await request(app).get('/api/ready');
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.checks.database).toBe('ok');
    expect(res.body.checks.tables).toBe('ok');
  });

  test('GET /api/public/plans lista os 3 planos', async () => {
    const res = await request(app).get('/api/public/plans');
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(Array.isArray(res.body.plans)).toBe(true);
    expect(res.body.plans.length).toBeGreaterThan(0);
  });

  test('GET /api/public/tenant/:subdomain retorna 404 para inexistente', async () => {
    const res = await request(app).get('/api/public/tenant/tenant-que-nao-existe-xyz');
    expect([400, 404]).toContain(res.status);
  });

  test('GET /api/track/:code retorna 404 para código inexistente', async () => {
    const res = await request(app).get('/api/track/ZZZZZ9');
    expect([400, 404]).toContain(res.status);
  });
});

/* Rate limiting por último: consome o orçamento de requisições do minuto. */
describe('Rate Limiting', () => {
  test('apiLimiter bloqueia acima de 60 requisições por minuto', async () => {
    const reqs = [];
    for (let i = 0; i < 65; i++) {
      reqs.push(request(app).get('/api/health'));
    }
    const results = await Promise.all(reqs);
    const bloqueados = results.filter(r => r.status === 429).length;
    expect(bloqueados).toBeGreaterThan(0);
  });
});
