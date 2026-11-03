/* ============================================================
   Cardápio Digital — Backend multi-tenant (SaaS)
   Node.js + Express 5 + PostgreSQL

   - Serve o front (raiz do repo) + API REST + eventos em tempo real (SSE)
   - Isolamento por tenant: middleware resolve o tenant (subdomínio/header/
     query/path) e TODA leitura/escrita passa por db/index.js → runTenant,
     que define app.current_tenant_id (RLS do Postgres).
   - Painel da plataforma em /api/super-admin (rota sem tenant).

   Subdomínios em produção: cliente.seusaas.com
   Dev local: http://localhost:3001?tenant=legado
   ============================================================ */
try { process.loadEnvFile && process.loadEnvFile(); } catch { /* .env é opcional */ }

const express = require('express');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const helmet = require('helmet');
const cors = require('cors');
const compression = require('compression');
const multer = require('multer');
const { v4: uuidv4 } = require('uuid');

const db = require('./db');
const tq = require('./db/tenantQuery');
const logger = require('./lib/logger');
const metrics = require('./lib/metrics');
const { hashPass, verifyPass } = require('./lib/passwords');
const { defaultConfig } = require('./lib/seed');
const { tenantResolver, invalidateTenantCache } = require('./middleware/tenantResolver');
const { requireAuth, requireRole, issueTenantToken } = require('./middleware/auth');
const quotas = require('./middleware/quotas');
const authRoutes = require('./routes/auth');
const superAdminRoutes = require('./routes/super-admin');
const billing = require('./services/billing');
const contracting = require('./services/contracting');
const { runMigrations } = require('./scripts/migrate');
const { tenantAssetDir, TENANTS_DIR } = require('./services/provisioning');

const app = express();
const PORT = Number(process.env.PORT) || 3001;

const allowedOrigins = Array.from(new Set((String(process.env.ALLOWED_ORIGINS || '')
  .split(',')
  .map(v => v.trim())
  .filter(Boolean)
  .concat(['http://localhost:3001', 'http://127.0.0.1:3001', 'http://localhost:8080', 'http://127.0.0.1:8080']))));

function ensureProductionHardening() {
  const warnings = [];
  const envName = String(process.env.NODE_ENV || 'development').toLowerCase();
  const jwtSecret = String(process.env.JWT_SECRET || '').trim();
  const wildcardDomain = String(process.env.WILDCARD_DOMAIN || '').trim().toLowerCase();
  const allowedOrigins = String(process.env.ALLOWED_ORIGINS || '').trim();
  const superAdminPass = String(process.env.SUPER_ADMIN_PASS || '').trim();
  const placeholderValues = [
    'troque-por-um-secreto-longo-aleatorio',
    'troque-por-senha-forte',
    'change-me',
    'changeme',
    'secret',
    'your-jwt-secret',
    'example-password'
  ];

  if (envName === 'production') {
    if (!allowedOrigins) {
      warnings.push('ALLOWED_ORIGINS is not set in production; configure the public domains and subdomains explicitly');
    }
    if (!wildcardDomain || /localhost|127\.0\.0\.1/.test(wildcardDomain)) {
      warnings.push('WILDCARD_DOMAIN should be the production root domain (for example: seusaas.com), not localhost');
    }
    if (!jwtSecret) {
      warnings.push('JWT_SECRET is missing');
    } else if (jwtSecret.length < 32 || placeholderValues.some(v => jwtSecret.toLowerCase().includes(v))) {
      warnings.push('JWT_SECRET is weak or still uses a placeholder value; rotate it before production');
    }
    if (!superAdminPass || placeholderValues.some(v => superAdminPass.toLowerCase().includes(v))) {
      warnings.push('SUPER_ADMIN_PASS is still a default placeholder; set a strong password before production');
    }
  }

  if (process.env.TENANT_RESOLVER && !['auto', 'subdomain', 'header', 'path'].includes(String(process.env.TENANT_RESOLVER).toLowerCase())) {
    warnings.push('TENANT_RESOLVER has an unsupported value; falling back to auto');
  }
  return warnings;
}
const corsOptions = {
  origin(origin, callback) {
    if (!origin || allowedOrigins.includes(origin)) return callback(null, true);
    let parsed;
    try { parsed = new URL(origin); } catch { return callback(null, false); }
    const base = String(process.env.WILDCARD_DOMAIN || '').trim().toLowerCase();
    const isLocalhost = base === 'localhost' || base.includes('127.0.0.1');
    const isTenantOrigin = !!base &&
      !isLocalhost &&
      parsed.origin === origin &&
      parsed.hostname.toLowerCase().endsWith('.' + base) &&
      (process.env.NODE_ENV !== 'production' || parsed.protocol === 'https:');
    return callback(null, isTenantOrigin);
  },
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-Tenant-ID', 'x-token']
};

fs.mkdirSync(path.join(TENANTS_DIR), { recursive: true });

/* ------------------- Helpers ------------------- */
const brl = v => 'R$ ' + (Number(v) || 0).toFixed(2).replace('.', ',');

function makeTrackCode(data) {
  /* Gera código sequencial: 0001, 0002, 0003... por tenant */
  const seq = (data.config && Number(data.config.orderSequence)) || 0;
  const next = seq + 1;
  data.config.orderSequence = next;
  return String(next).padStart(4, '0');
}

const IMAGE_TYPES = new Map([
  ['image/jpeg', 'jpg'],
  ['image/png', 'png'],
  ['image/gif', 'gif'],
  ['image/webp', 'webp']
]);

async function detectImageType(filePath) {
  const handle = await fs.promises.open(filePath, 'r');
  try {
    const header = Buffer.alloc(12);
    const { bytesRead } = await handle.read(header, 0, header.length, 0);
    if (bytesRead >= 8 && header.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'png';
    if (bytesRead >= 3 && header[0] === 0xff && header[1] === 0xd8 && header[2] === 0xff) return 'jpg';
    if (bytesRead >= 6 && ['GIF87a', 'GIF89a'].includes(header.toString('ascii', 0, 6))) return 'gif';
    if (bytesRead >= 12 && header.toString('ascii', 0, 4) === 'RIFF' && header.toString('ascii', 8, 12) === 'WEBP') return 'webp';
    return null;
  } finally {
    await handle.close();
  }
}

async function removeUploadedFile(filePath) {
  try {
    await fs.promises.unlink(filePath);
  } catch (e) {
    if (e.code !== 'ENOENT') throw e;
  }
}

/* ------------------- Estado por tenant -------------------
   O app continua tratando o estado como um objeto em memória por tenant
   (mesma lógica de negócio do single-tenant), mas cada objeto só enxerga
   as linhas do próprio tenant: o carregamento e a gravação são sempre
   filtrados por tenant_id, dentro de transação com RLS ativa. */
const stateCache = new Map(); // tenantId -> Promise<data>

async function getTenantState(tenantId) {
  if (stateCache.has(tenantId)) return stateCache.get(tenantId);
  const p = tq.loadTenantData(tenantId).catch(err => {
    stateCache.delete(tenantId);
    throw err;
  });
  stateCache.set(tenantId, p);
  return p;
}

async function persistTenantState(tenantId, data) {
  await tq.persistTenantData(tenantId, data);
  stateCache.set(tenantId, Promise.resolve(data));
}

function invalidateTenantState(tenantId) {
  if (tenantId) stateCache.delete(tenantId);
  else stateCache.clear();
}

/* Estado sem campos sensíveis de senha */
function sanitizeConfig(conf) {
  const c = Object.assign({}, conf || {});
  delete c.adminPasswordHash;
  delete c.adminPassword;
  return c;
}

function publicState(data) {
  return {
    products: data.products,
    categories: data.categories,
    bairros: data.bairros,
    coupons: data.coupons,
    config: sanitizeConfig(data.config)
  };
}

function adminState(data) {
  return {
    products: data.products,
    orders: data.orders,
    coupons: data.coupons,
    categories: data.categories,
    bairros: data.bairros,
    adminLog: data.adminLog,
    stockLog: data.stockLog,
    config: sanitizeConfig(data.config)
  };
}

/* ------------------- Rate limit simples (memória) ------------------- */
const rateBuckets = new Map();
const RATE_BUCKET_MAX = 10000;
let rateBucketOperations = 0;

function rateLimitCheck(key, max, windowMs) {
  const now = Date.now();
  if (++rateBucketOperations % 256 === 0 || rateBuckets.size >= RATE_BUCKET_MAX) {
    for (const [bucketKey, bucket] of rateBuckets) {
      if (now - bucket.start > bucket.windowMs) rateBuckets.delete(bucketKey);
    }
    while (rateBuckets.size >= RATE_BUCKET_MAX) {
      const oldestKey = rateBuckets.keys().next().value;
      if (oldestKey === undefined) break;
      rateBuckets.delete(oldestKey);
    }
  }
  const rec = rateBuckets.get(key);
  if (!rec || now - rec.start > windowMs) {
    rateBuckets.set(key, { start: now, n: 1, windowMs });
    return true;
  }
  rec.n++;
  return rec.n <= max;
}

function limitPublicReads(name, max, windowMs) {
  return (req, res, next) => {
    const key = `${name}:${req.tenantId || 'public'}:${req.ip}`;
    if (!rateLimitCheck(key, max, windowMs)) {
      res.setHeader('RateLimit-Limit', String(max));
      res.setHeader('RateLimit-Remaining', '0');
      res.setHeader('Retry-After', String(Math.ceil(windowMs / 1000)));
      return res.status(429).json({ ok: false, error: 'Muitas consultas. Aguarde antes de tentar novamente.' });
    }
    res.setHeader('RateLimit-Limit', String(max));
    res.setHeader('RateLimit-Remaining', String(Math.max(0, max - (rateBuckets.get(key) || {}).n)));
    next();
  };
}

/* ------------------- Horário de funcionamento ------------------- */
const DAY_MAP = { seg: 1, ter: 2, qua: 3, qui: 4, sex: 5, sab: 6, dom: 0, 'segunda': 1, 'terça': 2, terca: 2, 'quarta': 3, 'quinta': 4, 'sexta': 5, 'sábado': 6, sabado: 6, 'domingo': 0 };

function parseTimeHM(t) {
  if (!t) return -1;
  const m = String(t).trim().match(/^(\d{1,2}):(\d{2})$/);
  if (!m) return -1;
  return Number(m[1]) * 60 + Number(m[2]);
}

function isOpenNow(cfg) {
  if (!cfg || !cfg.days) return true;
  const open = parseTimeHM(cfg.openTime);
  const close = parseTimeHM(cfg.closeTime);
  if (open < 0 || close < 0) return true;
  const now = new Date();
  const cur = now.getHours() * 60 + now.getMinutes();
  const days = String(cfg.days).split(',').map(s => DAY_MAP[String(s).trim().toLowerCase()]);
  if (!days.includes(now.getDay())) return false;
  if (close <= open) return cur >= open || cur < close; // atravessa a meia-noite
  return cur >= open && cur < close;
}

/* ------------------- Preços e frete ------------------- */
/* Variação e extra são ADITIVOS (+R$), igual a js/cart.js:11-16, js/menu.js:425
   e os dados do cardápio (ex.: Heineken 9,90 + Pack 6 (45) = 54,90).
   Tratar a variação como preço absoluto zera o item quando a variação custa 0
   (ex.: "Lata 350ml") — o cliente vê R$ 30 e o servidor recalcula menos que o
   mínimo e rejeita o pedido com "Pedido mínimo". */
function calcItemPrice(p, variation, extras) {
  const base = p.promo && p.promoPrice ? p.promoPrice : p.price;
  const vAdd = variation ? (Number(variation.price) || 0) : 0;
  const eAdd = (extras || []).reduce((s, e) => s + (Number(e.price) || 0), 0);
  return base + vAdd + eAdd;
}

function calcFreight(subtotal, opts, cfg, bairros) {
  const type = opts.type || 'Entrega';
  if (type === 'Retirada') return 0;
  if (cfg.freteGratisAcima > 0 && subtotal >= cfg.freteGratisAcima) return 0;
  switch (cfg.freteMode) {
    case 'gratis': return 0;
    case 'fixo': return Number(cfg.freteFixo) || 0;
    case 'km': {
      const km = Number(opts.km) || 0;
      if (cfg.freteKmGratis > 0 && km >= cfg.freteKmGratis) return 0;
      return km * (Number(cfg.freteKmVal) || 0);
    }
    case 'bairro': {
      const b = (bairros || []).find(x => x.id === opts.bairroId);
      return b ? Number(b.tax) || 0 : 0;
    }
    default: return Number(cfg.freteFixo) || 0;
  }
}

/* ------------------- Eventos em tempo real (SSE) por tenant ------------------- */
const sseRooms = new Map(); // tenantId -> Set<res>
const sseTickets = new Map(); // token -> { tenantId, expiresAt }

function broadcast(tenantId, event, data) {
  const room = sseRooms.get(tenantId);
  if (!room || !room.size) return;
  const msg = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const client of room) {
    try { client.write(msg); } catch { room.delete(client); }
  }
}

function createSseTicket(tenantId) {
  const now = Date.now();
  for (const [token, ticket] of sseTickets) {
    if (ticket.expiresAt <= now) sseTickets.delete(token);
  }
  const token = crypto.randomBytes(32).toString('base64url');
  sseTickets.set(token, { tenantId, expiresAt: now + 30_000 });
  return token;
}

/* ------------------- Middlewares base ------------------- */
app.disable('x-powered-by');
app.use(helmet({
  contentSecurityPolicy: {
    useDefaults: true,
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'", "https://cdnjs.cloudflare.com"],
      styleSrc: ["'self'", "'unsafe-inline'", "https://fonts.googleapis.com"],
      fontSrc: ["'self'", "https://fonts.gstatic.com", "https://fonts.googleapis.com"],
      imgSrc: ["'self'", "data:", "blob:"],
      connectSrc: ["'self'", "https:"],
      frameAncestors: ["'none'"],
      formAction: ["'self'"],
      baseUri: ["'self'"],
      objectSrc: ["'none'"]
    }
  },
  hsts: { maxAge: 31536000, includeSubDomains: true, preload: true },
  crossOriginResourcePolicy: { policy: 'same-site' },
  frameguard: { action: 'deny' },
  referrerPolicy: { policy: 'strict-origin-when-cross-origin' },
  permissionsPolicy: {
    features: {
      geolocation: ["'self'"],
      microphone: ["'none'"],
      camera: ["'none'"],
      payment: ["'self'"]
    }
  }
}));
app.use(cors(corsOptions));
app.options(/^(.*)$/, cors(corsOptions));
app.use(compression());
app.use(express.json({
  limit: '2mb',
  // Webhooks de pagamento validam assinatura sobre o corpo cru, que o
  // express.json() consumiria. O `verify` roda antes do parse e guarda a
  // string original.
  verify: (req, _res, buf) => {
    req.rawBody = buf.toString('utf8');
  }
}));

/* Nada aqui pode ficar em cache de navegador/proxy: cardápio, painel e
   pedidos mudam o tempo todo e mostrar versão velha é pior que recarregar. */
app.use((req, res, next) => {
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Expires', '0');
  next();
});

app.use((req, res, next) => {
  req.requestId = String(req.get('x-request-id') || crypto.randomUUID()).slice(0, 128);
  res.setHeader('x-request-id', req.requestId);
  const startedAt = Date.now();
  res.on('finish', () => {
    logger.request(req, res, startedAt);
    metrics.observe({
      status: res.statusCode,
      route: `${req.method} ${(req.originalUrl || req.path).split('?')[0]}`,
      duration_ms: Date.now() - startedAt,
      error: res.statusCode >= 500
    });
  });
  next();
});

/* Upload por tenant (Fase 8.1): cada loja grava em data/tenants/{id}/produtos */
const upload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => {
      if (!req.tenantId) return cb(new Error('Tenant não identificado'));
      const dir = tenantAssetDir(req.tenantId);
      try {
        fs.mkdirSync(dir, { recursive: true });
        cb(null, dir);
      } catch (e) {
        cb(e);
      }
    },
    filename: (req, file, cb) => {
      cb(null, `${uuidv4()}.upload`);
    }
  }),
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (!IMAGE_TYPES.has(file.mimetype)) return cb(new Error('Formato de imagem não permitido'));
    cb(null, true);
  }
});

/* ------------------- Estáticos ------------------- */
/* O front vive na raiz do repo. Monta apenas caminhos públicos para não
   expor server.js, package.json, data/ nem o .git deste diretório. */
const PUBLIC_FILES = new Set(['index.html', 'manifest.json', '404.html', 'super-admin.html']);
const PUBLIC_DIRS = new Set(['css', 'js', 'assets', 'pages']);
function isPublicPath(p) {
  const rel = String(p || '').replace(/^\/+/, '');
  if (!rel) return true;
  return PUBLIC_FILES.has(rel) || PUBLIC_DIRS.has(rel.split('/')[0]);
}
const serveStatic = express.static(__dirname, { index: false, fallthrough: true });

/* ==================== API ==================== */

/* Todas as rotas /api passam pelo resolvedor de tenant.
   /api/super-admin/* e /api/public/tenant/:subdomain dispensam tenant. */
app.use('/api', tenantResolver);

/* Rate limiting global para todas as rotas /api */
const { apiLimiter } = require('./middleware/rateLimit');
app.use('/api', apiLimiter);

/* Middleware: verifica status do tenant após resolver
   - pending_approval: permite acesso apenas a rotas específicas (login admin, etc.)
   - trial expirado: bloqueia acesso
   Rotas públicas de lead/signup/plans não precisam de tenant ativo. */
app.use('/api', (req, res, next) => {
  const path = req.path || '';
  const isPublicRoute = 
    path.startsWith('/auth/') ||
    path === '/public/plans' ||
    path === '/public/leads' ||
    path === '/public/signup' ||
    path.startsWith('/public/contract/') ||
    path.startsWith('/public/tenant/');
  
  if (!req.tenant || isPublicRoute) return next();
  
  const tenant = req.tenant;
  
  // Trial expirado
  if (tenant.status === 'trial') {
    const trialEndsAt = tenant.trial_ends_at || new Date(new Date(tenant.created_at).getTime() + 14 * 24 * 60 * 60 * 1000);
    if (new Date(trialEndsAt).getTime() <= Date.now()) {
      return res.status(403).json({ 
        ok: false, 
        code: 'TRIAL_EXPIRED', 
        error: 'Período de teste de 7 dias encerrado. Escolha um plano pago para continuar.',
        trialExpired: true
      });
    }
  }
  
  // Pendente de aprovação (planos pagos)
  if (tenant.status === 'pending_approval') {
    // Permite acesso ao painel admin para o dono ver status
    // Bloqueia cardápio público e APIs de pedido
    const isPublicMenu = path === '/public' || path.startsWith('/public/');
    
    if (isPublicMenu) {
      return res.status(403).json({ 
        ok: false, 
        code: 'PENDING_APPROVAL', 
        error: 'Sua loja está aguardando aprovação do administrador da plataforma.',
        pendingApproval: true
      });
    }
  }
  
  next();
});

/* Assets do tenant (Fase 8.2): valida o tenant e serve o arquivo do diretório dele */
app.get('/assets/tenants/:tenantId/produtos/:file', async (req, res) => {
  const { tenantId, file } = req.params;
  if (!/^[0-9a-f-]{36}$/i.test(tenantId)) return res.status(404).send('Não encontrado');
  if (!/^[A-Za-z0-9._-]+$/.test(file) || file.includes('..')) return res.status(404).send('Não encontrado');

  try {
    const t = await db.queryApp(
      `SELECT id FROM tenants
       WHERE id = $1 AND deleted_at IS NULL
         AND (
           (status = 'active' AND (subscription_expires_at IS NULL OR subscription_expires_at > NOW()))
           OR (status = 'trial' AND COALESCE(trial_ends_at, created_at + INTERVAL '14 days') > NOW())
           OR (status = 'pending_approval')
         )`,
      [tenantId]
    );
    if (!t.rows.length) return res.status(404).send('Não encontrado');
  } catch {
    return res.status(500).send('Erro ao verificar tenant');
  }

  const filePath = path.join(tenantAssetDir(tenantId), file);
  res.sendFile(filePath, err => {
    if (err) res.status(404).send('Não encontrado');
  });
});

/* Página inicial e estáticos */
app.get('/', (req, res) => {
  if (req.query.tenant) return res.redirect('/cardapio?tenant=' + encodeURIComponent(req.query.tenant));
  res.sendFile(path.join(__dirname, 'pages', 'landing.html'));
});
app.get('/landing', (req, res) => res.sendFile(path.join(__dirname, 'pages', 'landing.html')));
app.get('/cardapio', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));
app.get('/acompanhar', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));
app.get('/super-admin', (req, res) => res.sendFile(path.join(__dirname, 'pages', 'super-admin.html')));
app.get('/super-admin.html', (req, res) => res.sendFile(path.join(__dirname, 'pages', 'super-admin.html')));
app.use((req, res, next) => {
  if (!isPublicPath(req.path)) return next();
  serveStatic(req, res, next);
});

/* ------------------- Rotas de tenant (admin e cardápio) ------------------- */
/* ------------------- Rotas públicas (webhooks, health, etc.) ------------------- */
app.use('/api/webhooks', require('./routes/webhooks'));
app.use('/api/auth', authRoutes);
app.use('/api/super-admin', superAdminRoutes);

/* Verifica se um tenant existe (usado pelo front antes de carregar o cardápio).
   Aceita apelido (slug/subdomínio) OU nome fantasia da loja. */
app.get('/api/public/tenant/:subdomain', limitPublicReads('tenant-info', 120, 60 * 1000), async (req, res) => {
  const sub = String(req.params.subdomain || '').trim().toLowerCase();
  try {
    let r = await db.queryApp(
      `SELECT id, name, subdomain, plan, status, trial_ends_at, subscription_expires_at FROM tenants
       WHERE (subdomain = $1 OR slug = $1 OR lower(name) = $1) AND deleted_at IS NULL`,
      [sub]
    );
    // busca parcial: "alves" acha "Alves Distribuidora"
    if (!r.rows.length && sub.length >= 3) {
      r = await db.queryApp(
        `SELECT id, name, subdomain, plan, status, trial_ends_at, subscription_expires_at FROM tenants
         WHERE (subdomain LIKE '%' || $1 || '%' OR slug LIKE '%' || $1 || '%'
                OR lower(name) LIKE '%' || $1 || '%')
           AND deleted_at IS NULL
         ORDER BY created_at LIMIT 1`,
        [sub]
      );
    }
    if (!r.rows.length) return res.status(404).json({ ok: false, error: 'Loja não encontrada' });
    const t = r.rows[0];
    let active = false;
    let trialExpired = false;
    let pendingApproval = false;
    
    if (t.status === 'active') {
      active = !t.subscription_expires_at || new Date(t.subscription_expires_at).getTime() > Date.now();
    } else if (t.status === 'trial') {
      const trialEndsAt = t.trial_ends_at || new Date(new Date(t.created_at).getTime() + 7 * 24 * 60 * 60 * 1000);
      active = new Date(trialEndsAt).getTime() > Date.now();
      trialExpired = !active;
    } else if (t.status === 'pending_approval') {
      pendingApproval = true;
    }
    
    res.json({
      ok: true,
      tenant: { 
        name: t.name, 
        subdomain: t.subdomain, 
        plan: t.plan, 
        status: t.status, 
        active,
        trialExpired,
        pendingApproval,
        trialEndsAt: t.trial_ends_at,
        subscriptionExpiresAt: t.subscription_expires_at
      }
    });
  } catch (e) {
    logger.routeError(req, '/api/public/tenant/:subdomain', e);
    res.status(500).json({ ok: false, error: 'Erro ao buscar loja' });
  }
});

/* Planos públicos (landing page da plataforma): só dados comerciais,
   sem tenant e sem autenticação */
app.get('/api/public/plans', limitPublicReads('public-plans', 120, 60 * 1000), async (req, res) => {
  try {
    const plans = await billing.listPlans();
    let supportWhatsapp = '';
    try {
      const t = await db.runSuper('SELECT support_whatsapp FROM saas_templates WHERE id = $1', ['default']);
      supportWhatsapp = (t.rows[0] && t.rows[0].support_whatsapp) || '';
    } catch { /* campo ainda não migrado: ignora */ }
    res.json({
      ok: true,
      support_whatsapp: supportWhatsapp,
      plans: plans.map(p => ({
        id: p.id, name: p.name,
        priceMonthly: Number(p.priceMonthly || 0),
        limits: p.limits || {}, features: p.features || {}
      }))
    });
  } catch (e) {
    logger.routeError(req, '/api/public/plans', e);
    res.status(500).json({ ok: false, error: 'Erro ao listar planos' });
  }
});

/* Lead de contratação (landing page): registra a intenção quando o visitante
   clica em "Assinar" / "Falar no WhatsApp", para o Super Admin ser notificado. */
app.post('/api/public/leads', limitPublicReads('public-lead', 20, 60 * 1000), async (req, res) => {
  try {
    const b = req.body || {};
    const plan = String(b.plan || '').trim().slice(0, 50);
    const name = String(b.name || '').trim().slice(0, 120);
    const whatsapp = String(b.whatsapp || '').replace(/[^\d+]/g, '').slice(0, 20);
    const source = (String(b.source || 'landing').trim().slice(0, 30)) || 'landing';
    let message = String(b.message || '').trim().slice(0, 1000);
    if (!message) message = 'Contato pela landing page' + (plan ? ' — plano ' + plan : '');
    const r = await db.runSuper(
      `INSERT INTO saas_leads (plan, name, whatsapp, message, source)
       VALUES ($1, $2, $3, $4, $5) RETURNING id`,
      [plan, name, whatsapp, message, source]
    );
    res.status(201).json({ ok: true, id: r.rows[0].id });
  } catch (e) {
    logger.routeError(req, '/api/public/leads', e);
    res.status(500).json({ ok: false, error: 'Erro ao registrar contato' });
  }
});

/* ------------------- contratação self-service (conta antes do pagamento) ---- */

/* Cria a conta do cliente (trial/grátis) e a assinatura aguardando pagamento.
   A ativação do plano pago é feita pelo Super Admin, nunca pelo frontend. */
app.post('/api/public/signup', limitPublicReads('public-signup', 5, 60 * 60 * 1000), async (req, res) => {
  try {
    const result = await contracting.signup(req.body || {});
    invalidateTenantCache();
    logger.info('saas_signup', {
      tenant: result.subdomain,
      plan: result.plan,
      status: result.status
    });
    res.status(201).json({ ok: true, ...result });
  } catch (e) {
    if (e.code === 'CONTRACT_INVALID' || e.code === 'TENANT_INVALID' || e.code === 'SUBDOMAIN_TAKEN') {
      return res.status(400).json({ ok: false, code: e.code, error: e.message });
    }
    if (e.code === '23505') {
      return res.status(409).json({ ok: false, error: 'Subdomínio ou e-mail já existe' });
    }
    logger.routeError(req, '/api/public/signup', e);
    res.status(500).json({ ok: false, error: 'Erro ao criar a sua conta' });
  }
});

/* Acompanhamento público da contratação pelo cliente */
app.get('/api/public/contract/:token', async (req, res) => {
  try {
    const info = await contracting.getByToken(req.params.token);
    if (!info) return res.status(404).json({ ok: false, error: 'Contratação não encontrada' });
    const pix = await contracting.platformPix();
    res.json({
      ok: true,
      contract: info,
      pix: { key: pix.key, name: pix.name },
      supportWhatsapp: pix.whatsapp
    });
  } catch (e) {
    logger.routeError(req, '/api/public/contract', e);
    res.status(500).json({ ok: false, error: 'Erro ao consultar a contratação' });
  }
});

/* Cliente informa que pagou: gera o comprovante pendente para aprovação */
app.post('/api/public/contract/:token/confirm', limitPublicReads('public-contract-confirm', 10, 60 * 60 * 1000), async (req, res) => {
  try {
    const r = await contracting.reportPayment(req.params.token);
    res.json({
      ok: true,
      alreadyActive: !!r.alreadyActive,
      alreadyReported: !!r.alreadyReported,
      contract: r.contract
    });
  } catch (e) {
    if (e.code === 'CONTRACT_NOT_FOUND') {
      return res.status(404).json({ ok: false, error: e.message });
    }
    logger.routeError(req, '/api/public/contract/:token/confirm', e);
    res.status(500).json({ ok: false, error: 'Erro ao informar o pagamento' });
  }
});

/* ------------------- API: saúde ------------------- */
app.get('/api/health', async (req, res) => {
  let dbOk = true;
  try {
    await db.ping();
  } catch {
    dbOk = false;
  }
  const health = {
    ok: dbOk,
    db: dbOk ? 'up' : 'down'
  };
  res.status(dbOk ? 200 : 503).json(health);
});

app.get('/api/ready', async (req, res) => {
  const start = Date.now();
  try {
    await db.ping();
    
    // Check critical tables exist and are accessible
    await db.runSuper('SELECT 1 FROM tenants LIMIT 1');
    await db.runSuper('SELECT 1 FROM plans LIMIT 1');
    await db.runSuper('SELECT 1 FROM super_admins LIMIT 1');
    
    const duration = Date.now() - start;
    res.json({ 
      ok: true, 
      ready: true, 
      checks: {
        database: 'ok',
        tables: 'ok'
      },
      duration_ms: duration,
      time: Date.now() 
    });
  } catch (error) {
    logger.error('readiness_check_failed', { 
      message: error && error.message ? error.message : String(error),
      duration_ms: Date.now() - start
    });
    res.status(503).json({ 
      ok: false, 
      ready: false, 
      error: 'dependencies unavailable',
      time: Date.now() 
    });
  }
});

/* ------------------- API: eventos (SSE, sala por tenant) ------------------- */
app.post('/api/events/ticket', requireAuth, (req, res) => {
  if (req.superAdmin || !req.tenantId) {
    return res.status(403).json({ ok: false, error: 'Acesso restrito a usuários da loja' });
  }
  res.setHeader('Cache-Control', 'no-store');
  res.status(201).json({ ok: true, ticket: createSseTicket(req.tenantId) });
});

app.get('/api/events', (req, res) => {
  if (!req.tenantId) return res.status(400).end();
  const token = String(req.query.ticket || '');
  const ticket = sseTickets.get(token);
  sseTickets.delete(token);
  if (!ticket || ticket.expiresAt <= Date.now()) {
    return res.status(401).json({ ok: false, error: 'Ticket de eventos inválido ou expirado' });
  }
  if (ticket.tenantId !== req.tenantId) {
    return res.status(403).json({ ok: false, code: 'TENANT_MISMATCH', error: 'Acesso negado a este tenant' });
  }

  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no'
  });
  res.write('retry: 3000\n\n');

  if (!sseRooms.has(req.tenantId)) sseRooms.set(req.tenantId, new Set());
  const room = sseRooms.get(req.tenantId);
  room.add(res);

  const heartbeat = setInterval(() => {
    try { res.write(': ping\n\n'); } catch { /* fecha no onerror */ }
  }, 25000);

  req.on('close', () => {
    clearInterval(heartbeat);
    room.delete(res);
    if (!room.size) sseRooms.delete(req.tenantId);
  });
});

/* ------------------- API: login (alias legado do painel) -------------------
   Mantém o contrato antigo (POST /api/login) porque o front já usa esse
   caminho; o novo contrato completo está em /api/auth/login. Aqui ainda
   devolvemos `state` para o painel abrir já preenchido. */
app.post('/api/login', async (req, res) => {
  if (!req.tenantId) return res.status(400).json({ ok: false, code: 'TENANT_REQUIRED', error: 'Tenant não identificado' });
  if (!rateLimitCheck('login:' + req.tenantId + ':' + req.ip, 10, 15 * 60 * 1000)) {
    return res.status(429).json({ ok: false, error: 'Muitas tentativas. Aguarde alguns minutos.' });
  }

  const email = String((req.body && req.body.email) || '').trim().toLowerCase();
  const password = String((req.body && req.body.password) || '');
  if (!email) {
    return res.status(400).json({ ok: false, error: 'Informe o e-mail' });
  }
  if (!password) {
    return res.status(400).json({ ok: false, error: 'Informe a senha' });
  }

  try {
    const u = await db.runTenant(req.tenantId,
      `SELECT id, email, password_hash, name, role, permissions FROM users
       WHERE tenant_id = $1 AND lower(email) = lower($2) AND active`,
      [req.tenantId, email]
    );
    const user = u.rows[0] || null;
    if (!user || !verifyPass(password, user.password_hash)) {
      return res.status(401).json({ ok: false, error: 'E-mail ou senha incorretos' });
    }

    const token = issueTenantToken(user, req.tenantId);
    await db.runTenant(req.tenantId, 'UPDATE users SET last_login = NOW(), updated_at = NOW() WHERE id = $1', [user.id]);

    const data = await getTenantState(req.tenantId);
    res.json({
      ok: true,
      token,
      user: { id: user.id, email: user.email, name: user.name, role: user.role },
      tenant: { id: req.tenant.id, name: req.tenant.name, subdomain: req.tenant.subdomain, plan: req.tenant.plan },
      state: adminState(data)
    });
  } catch (e) {
    logger.routeError(req, '/api/login', e);
    res.status(500).json({ ok: false, error: 'Erro ao autenticar' });
  }
});

app.post('/api/logout', requireAuth, (req, res) => {
  res.json({ ok: true });
});

/* ------------------- API: admin (estado do tenant) ------------------- */
app.get('/api/admin/state', requireAuth, async (req, res) => {
  try {
    const data = await getTenantState(req.tenantId);
    const info = await quotas.checkLimit(req.tenantId, 'products');
    quotas.quotaHeaders(res, 'products', info);
    res.json({ ok: true, state: adminState(data), quota: { products: info } });
  } catch (e) {
    logger.routeError(req, '/api/admin/state', e);
    res.status(500).json({ ok: false, error: 'Erro ao carregar dados' });
  }
});

app.put('/api/admin/state', requireAuth, requireRole('admin', 'operator'), async (req, res) => {
  const s = req.body || {};
  try {
    const violations = await quotas.checkStateLimits(req.tenantId, s);
    if (violations) {
      const first = violations[0];
      return res.status(403).json({
        ok: false,
        code: 'QUOTA_EXCEEDED',
        resource: first.resource,
        limit: first.limit,
        current: first.current,
        violations,
        error: `Limite do plano atingido (${first.resource}: ${first.current}/${first.limit}). Faça upgrade para continuar.`
      });
    }

    const data = await getTenantState(req.tenantId);
    const incomingConfig = Object.assign({}, s.config);
    delete incomingConfig.adminPassword;
    delete incomingConfig.adminPasswordHash;
    const mergedConfig = Object.assign({}, data.config, incomingConfig);
    // campos que nunca podem ser apagados pelo payload
    for (const [k, v] of Object.entries(defaultConfig())) {
      if (mergedConfig[k] === undefined) mergedConfig[k] = v;
    }

    data.products = Array.isArray(s.products) ? s.products : data.products;
    if (Array.isArray(s.orders) && (data.orders.length === 0 || s.orders.length > 0)) data.orders = s.orders;
    data.coupons = Array.isArray(s.coupons) ? s.coupons : data.coupons;
    data.categories = Array.isArray(s.categories) ? s.categories : data.categories;
    data.bairros = Array.isArray(s.bairros) ? s.bairros : data.bairros;
    data.adminLog = Array.isArray(s.adminLog) ? s.adminLog : data.adminLog;
    data.stockLog = Array.isArray(s.stockLog) ? s.stockLog : data.stockLog;
    data.config = mergedConfig;

    await persistTenantState(req.tenantId, data);
    broadcast(req.tenantId, 'sync', { t: Date.now() });
    res.json({ ok: true });
  } catch (e) {
    logger.routeError(req, '/api/admin/state (PUT)', e);
    res.status(500).json({ ok: false, error: 'Erro ao salvar dados' });
  }
});

/* Troca a senha do usuário logado (mantém o contrato antigo { old, new }) */
app.post('/api/admin/password', requireAuth, async (req, res) => {
  const old = String((req.body && req.body.old) || '');
  const next = String((req.body && req.body.new) || '');
  try {
    const u = await db.runTenant(req.tenantId, 'SELECT id, password_hash FROM users WHERE id = $1 AND active', [req.user.sub]);
    if (!u.rows.length) return res.status(404).json({ ok: false, error: 'Usuário não encontrado' });
    if (!verifyPass(old, u.rows[0].password_hash)) {
      return res.status(400).json({ ok: false, error: 'Senha atual incorreta' });
    }
    if (next.length < 4) return res.status(400).json({ ok: false, error: 'Senha muito curta (mín. 4)' });

    await db.runTenant(req.tenantId, 'UPDATE users SET password_hash = $1, updated_at = NOW() WHERE id = $2', [hashPass(next), u.rows[0].id]);
    await db.runTenant(req.tenantId, 
      'UPDATE refresh_tokens SET revoked_at = NOW() WHERE user_id = $1 AND revoked_at IS NULL',
      [u.rows[0].id]
    );
    broadcast(req.tenantId, 'sync', { t: Date.now() });
    res.json({ ok: true });
  } catch (e) {
    logger.routeError(req, '/api/admin/password', e);
    res.status(500).json({ ok: false, error: 'Erro ao trocar senha' });
  }
});

/* Upload de imagem do tenant */
app.post('/api/admin/upload', requireAuth, requireRole('admin', 'operator'), (req, res) => {
  upload.single('image')(req, res, async err => {
    if (err) return res.status(400).json({ ok: false, error: 'Falha no upload: ' + err.message });
    if (!req.file) return res.status(400).json({ ok: false, error: 'Nenhum arquivo' });

    let uploadedPath = req.file.path;
    try {
      const imageType = await detectImageType(uploadedPath);
      if (!imageType) {
        await removeUploadedFile(uploadedPath);
        return res.status(400).json({ ok: false, error: 'O arquivo enviado não é uma imagem válida' });
      }
      const filename = `${uuidv4()}.${imageType}`;
      const imagePath = path.join(path.dirname(uploadedPath), filename);
      await fs.promises.rename(uploadedPath, imagePath);
      uploadedPath = imagePath;

      const usedMb = await quotas.tenantUsageMb(tenantAssetDir(req.tenantId));
      const info = await quotas.checkLimit(req.tenantId, 'storage_mb', usedMb);
      quotas.quotaHeaders(res, 'storage_mb', { limit: info.limit, remaining: info.limit === null ? null : Math.max(0, info.limit - usedMb) });
      if (!info.allowed) {
        await removeUploadedFile(uploadedPath);
        return quotas.quotaError(res, 'storage_mb', { limit: info.limit, current: usedMb });
      }
      res.json({ ok: true, url: `/assets/tenants/${req.tenantId}/produtos/${filename}` });
    } catch (e) {
      try {
        await removeUploadedFile(uploadedPath);
      } catch (cleanupError) {
        logger.error('upload_cleanup_failed', { message: cleanupError.message, tenantId: req.tenantId });
      }
      logger.routeError(req, '/api/admin/upload', e);
      res.status(500).json({ ok: false, error: 'Erro ao salvar imagem' });
    }
  });
});

/* ------------------- API: público (cardápio) ------------------- */
app.get('/api/public', limitPublicReads('public-menu', 120, 60 * 1000), async (req, res) => {
  try {
    const data = await getTenantState(req.tenantId);
    res.json({
      ok: true,
      state: publicState(data),
      tenant: { name: req.tenant.name, subdomain: req.tenant.subdomain, plan: req.tenant.plan }
    });
  } catch (e) {
    logger.routeError(req, '/api/public', e);
    res.status(500).json({ ok: false, error: 'Erro ao carregar cardápio' });
  }
});

/* ------------------- API: pedidos ------------------- */
app.get('/api/orders/:id', limitPublicReads('order-status', 60, 60 * 1000), async (req, res) => {
  try {
    const data = await getTenantState(req.tenantId);
    const o = data.orders.find(x => String(x.id) === String(req.params.id));
    if (!o) return res.status(404).json({ ok: false, error: 'Pedido não encontrado' });
    res.json({ ok: true, status: o.status });
  } catch {
    res.status(500).json({ ok: false, error: 'Erro ao buscar pedido' });
  }
});

app.post('/api/orders', async (req, res) => {
  const body = req.body || {};

  if (!rateLimitCheck('orders:' + req.tenantId + ':' + req.ip, 10, 60 * 1000)) {
    return res.status(429).json({ ok: false, error: 'Muitos pedidos em pouco tempo. Aguarde um instante.' });
  }

  let data;
  try {
    data = await getTenantState(req.tenantId);
  } catch {
    return res.status(500).json({ ok: false, error: 'Erro ao carregar dados da loja' });
  }
  try {
    const orderQuota = await quotas.checkLimit(req.tenantId, 'orders_month');
    quotas.quotaHeaders(res, 'orders_month', orderQuota);
    if (!orderQuota.allowed) return quotas.quotaError(res, 'orders_month', orderQuota);
  } catch (e) {
    logger.routeError(req, '/api/orders', e);
    return res.status(500).json({ ok: false, error: 'Erro ao verificar limite de pedidos' });
  }
  const cfg = data.config;

  if (cfg.blockWhenClosed && !isOpenNow(cfg)) {
    return res.status(400).json({
      ok: false, code: 'STORE_CLOSED',
      error: `Estamos fechados no momento. O envio de pedidos está desativado. Horário: ${cfg.hours || 'consulte nosso cardápio'}`
    });
  }

  /* --- cliente --- */
  const customer = String(body.customer || '').trim();
  if (!customer) return res.status(400).json({ ok: false, error: 'Informe seu nome' });
  const type = body.type === 'Retirada' ? 'Retirada' : 'Entrega';
  const payment = String(body.payment || '').trim() || 'Pix';
  const address = String(body.address || '').trim();
  const obs = String(body.notes || body.obs || '').trim();
  const phone = String(body.phone || '').trim();
  const change = String(body.change || '').trim();
  const bairroId = body.bairroId ? String(body.bairroId) : '';
  const km = Number(body.km) || 0;

  if (type === 'Entrega' && !address) return res.status(400).json({ ok: false, error: 'Informe o endereço' });
  if (type === 'Entrega' && cfg.freteMode === 'bairro' && !bairroId) return res.status(400).json({ ok: false, error: 'Selecione o bairro' });
  if (type === 'Entrega' && cfg.freteMode === 'km' && !km) return res.status(400).json({ ok: false, error: 'Informe a distância em KM' });

  /* --- itens (valida e recalcula preços no servidor) --- */
  if (!Array.isArray(body.items) || !body.items.length) return res.status(400).json({ ok: false, error: 'Carrinho vazio' });

  const items = [];
  const stockChecks = {};
  for (const it of body.items) {
    const p = data.products.find(x => x.id === it.id && x.active !== false);
    if (!p) return res.status(400).json({ ok: false, error: 'Produto indisponível' });
    if (cfg.blockOutOfStock && p.stock <= 0) return res.status(400).json({ ok: false, error: `Sem estoque: ${p.name}` });
    const qty = Math.max(1, parseInt(it.qty) || 1);
    const prev = stockChecks[p.id] || 0;
    if (p.stock < prev + qty) return res.status(400).json({ ok: false, error: `Estoque insuficiente: ${p.name}` });
    stockChecks[p.id] = prev + qty;

    const variation = it.variation
      ? (p.variations || []).find(v => v.name === it.variation) || null
      : null;
    const extras = Array.isArray(it.extras)
      ? (p.extras || []).filter(e => it.extras.includes(e.name)).map(e => ({ name: e.name, price: e.price }))
      : [];
    const unit = calcItemPrice(p, variation, extras);
    items.push({
      name: p.name,
      productId: p.id,
      variation: variation ? variation.name : '',
      extras: extras.map(e => e.name),
      obs: String(it.obs || ''),
      qty,
      unit: +unit.toFixed(2),
      total: +(unit * qty).toFixed(2)
    });
  }

  const subtotal = +items.reduce((s, i) => s + i.total, 0).toFixed(2);

  /* --- cupom --- */
  let discount = 0;
  let couponCode = '';
  let freeFreight = false;
  if (body.coupon) {
    const coupon = data.coupons.find(c => String(c.code).toUpperCase() === String(body.coupon).toUpperCase() && c.active);
    if (coupon) {
      if (coupon.limit && coupon.uses >= coupon.limit) {
        return res.json({ ok: false, code: 'COUPON_LIMIT', error: 'Cupom esgotado' });
      }
      if (Number(coupon.min) > 0 && subtotal < Number(coupon.min)) {
        return res.json({ ok: false, code: 'COUPON_MIN', error: `Mínimo de ${brl(Number(coupon.min))} para este cupom` });
      }
      if (coupon.first && !phone) {
        return res.json({ ok: false, code: 'COUPON_FIRST', error: 'Informe seu telefone para usar este cupom' });
      }
      if (coupon.first && phone && data.orders.some(o => o.phone && o.phone === phone)) {
        return res.json({ ok: false, code: 'COUPON_FIRST', error: 'Este cupom é só para a primeira compra' });
      }
      if (Number(coupon.per) > 0 && phone) {
        const usedByCust = data.orders.filter(o => o.phone === phone && o.coupon === String(coupon.code).toUpperCase()).length;
        if (usedByCust >= Number(coupon.per)) {
          return res.json({ ok: false, code: 'COUPON_PER', error: 'Você já usou este cupom' });
        }
      }
      if (coupon.type === 'frete') {
        if (type !== 'Retirada') freeFreight = true;
        couponCode = coupon.code;
      } else if (coupon.type === 'percent') {
        discount = +((subtotal * Number(coupon.value)) / 100).toFixed(2);
        couponCode = coupon.code;
      } else {
        discount = Math.min(Number(coupon.value) || 0, subtotal);
        discount = +discount.toFixed(2);
        couponCode = coupon.code;
      }
    }
  }

  const subAfterDiscount = Math.max(0, subtotal - discount);
  if (cfg.minOrder > 0 && subAfterDiscount < cfg.minOrder) {
    const falta = +(cfg.minOrder - subAfterDiscount).toFixed(2);
    return res.status(400).json({
      ok: false, code: 'MIN_ORDER',
      error: `Pedido mínimo de ${brl(cfg.minOrder)} — seus produtos (${brl(subAfterDiscount)}${discount ? ' após o cupom' : ''}) ficam ${brl(falta)} abaixo`
    });
  }

  const deliveryBase = type === 'Retirada' ? 0 : calcFreight(subAfterDiscount, { type, bairroId, km }, cfg, data.bairros);
  const delivery = freeFreight && type !== 'Retirada' ? 0 : deliveryBase;
  const total = +(subAfterDiscount + delivery).toFixed(2);

  const bairroName = bairroId ? ((data.bairros.find(b => b.id === bairroId) || {}).name || '') : '';

  const order = {
    id: crypto.randomUUID(),
    trackCode: makeTrackCode(data),
    customer, phone, address, type, payment, notes: obs, change,
    bairro: bairroName, km: km || null,
    items, subtotal, discount,
    coupon: couponCode,
    freeFreight: freeFreight || false,
    delivery, total,
    status: 'pendente',
    statusUpdatedAt: new Date().toISOString(),
    createdAt: new Date().toISOString()
  };

  /* --- aplica efeitos: estoque e uso de cupom (por tenant) --- */
  items.forEach(i => {
    const p = data.products.find(x => x.id === i.productId) || data.products.find(x => x.name === i.name);
    if (p) p.stock = Math.max(0, p.stock - i.qty);
  });
  if (couponCode) {
    const c = data.coupons.find(c => c.code === couponCode);
    if (c) c.uses = (c.uses || 0) + 1;
  }

  data.orders.unshift(order);

  try {
    await persistTenantState(req.tenantId, data);
  } catch (e) {
    logger.routeError(req, '/api/orders (PUT)', e);
    return res.status(500).json({ ok: false, error: 'Erro ao salvar pedido' });
  }

  broadcast(req.tenantId, 'sync', { t: Date.now() });
  res.json({ ok: true, order, waUrl: `/api/orders/${order.id}/wa` });
});

/* Link do WhatsApp pronto para o pedido (recalculado no servidor) */
app.get('/api/orders/:id/wa', limitPublicReads('order-whatsapp', 60, 60 * 1000), async (req, res) => {
  try {
    const data = await getTenantState(req.tenantId);
    const o = data.orders.find(x => String(x.id) === String(req.params.id));
    if (!o) return res.status(404).json({ ok: false, error: 'Pedido não encontrado' });

    const cfg = data.config;
    let m = `*🥤 NOVO PEDIDO #${o.id}*\n\n`;
    m += `*Cliente:* ${o.customer}\n`;
    if (o.phone) m += `*Telefone:* ${o.phone}\n`;
    m += `*Tipo:* ${o.type}\n`;
    if (o.type === 'Entrega' && o.address) m += `*Endereço:* ${o.address}\n`;
    if (o.bairro) m += `*Bairro:* ${o.bairro}\n`;
    if (o.km) m += `*Distância:* ${o.km} km\n`;
    m += `*Pagamento:* ${o.payment}\n`;
    if (o.change) m += `*Troco para:* ${o.change}\n`;
    m += `\n*ITENS:*\n`;
    (o.items || []).forEach(i => {
      m += `• ${i.qty}x ${i.name}${i.variation ? ' (' + i.variation + ')' : ''}`;
      if (i.extras && i.extras.length) m += ` + ${i.extras.join(', ')}`;
      m += ` — ${brl(i.total)}\n`;
      if (i.obs) m += `   📝 _${i.obs}_\n`;
    });
    m += `\n*Subtotal:* ${brl(o.subtotal)}`;
    if (o.discount) m += `\n*Desconto (${o.coupon}):* − ${brl(o.discount)}`;
    if (o.delivery) m += `\n*Frete:* ${brl(o.delivery)}`;
    m += `\n*TOTAL:* ${brl(o.total)}`;
    if (o.notes) m += `\n\n*Obs geral:* ${o.notes}`;
    const base = `${req.protocol}://${req.get('host')}`;
    if (o.trackCode) m += `\n\n🔎 *Acompanhe:* ${base}/acompanhar?c=${o.trackCode}`;
    const url = `https://wa.me/${cfg.whatsapp}?text=${encodeURIComponent(m)}`;
    res.redirect(url);
  } catch {
    res.status(500).json({ ok: false, error: 'Erro ao gerar link' });
  }
});

/* ------------------- API: acompanhamento ------------------- */
app.get('/api/track/:code', limitPublicReads('order-track', 60, 60 * 1000), async (req, res) => {
  const code = String(req.params.code || '').toUpperCase();
  try {
    const data = await getTenantState(req.tenantId);
    const o = data.orders.find(x => String(x.trackCode || '').toUpperCase() === code);
    if (!o) return res.status(404).json({ ok: false, error: 'Pedido não encontrado' });
    res.json({
      ok: true,
      order: {
        id: o.id, status: o.status, statusLabel: o.status,
        createdAt: o.createdAt, statusUpdatedAt: o.statusUpdatedAt || o.createdAt,
        total: o.total, trackCode: o.trackCode
      }
    });
  } catch {
    res.status(500).json({ ok: false, error: 'Erro ao buscar pedido' });
  }
});

/* ------------------- Erros ------------------- */
app.use((err, req, res, next) => {
  logger.error('unhandled_error', {
    request_id: req && req.requestId ? req.requestId : null,
    method: req && req.method ? req.method : 'UNKNOWN',
    path: req && req.originalUrl ? req.originalUrl.split('?')[0] : null,
    tenant_id: req && req.tenantId ? req.tenantId : null,
    message: err && err.message ? err.message : String(err)
  });
  if (res.headersSent) return next(err);
  res.status(500).json({ ok: false, error: 'Erro interno' });
});

/* ------------------- Boot ------------------- */
async function init() {
  const warnings = ensureProductionHardening();
  if (warnings.length) {
    logger.warn('startup_hardening_check', { warnings });
  }

  if (!process.env.DATABASE_URL) {
    throw new Error('DATABASE_URL não definida — copie .env.example para .env');
  }
  if (!process.env.JWT_SECRET) {
    throw new Error('JWT_SECRET não definido — copie .env.example para .env');
  }

  const envName = String(process.env.NODE_ENV || 'development').toLowerCase();
  if (envName === 'production') {
    if (warnings.length) {
      throw new Error('Configuração de produção incompleta: ' + warnings.join('; '));
    }
    if (String(process.env.JWT_SECRET || '').trim().length < 32) {
      throw new Error('JWT_SECRET muito curto para produção: use pelo menos 32 caracteres');
    }
  }

  // migrations pendentes (idempotente; em produção o CI roda antes)
  try {
    await runMigrations();
  } catch (e) {
    throw new Error('Falha nas migrations: ' + e.message, { cause: e });
  }

  await db.ping();

  // super-admin inicial (do .env) — só cria se a tabela estiver vazia
  try {
    const existing = await db.runSuper('SELECT COUNT(*)::int AS c FROM super_admins');
    if (!existing.rows[0].c) {
      const email = String(process.env.SUPER_ADMIN_EMAIL || '').trim().toLowerCase();
      const pass = String(process.env.SUPER_ADMIN_PASS || '').trim();
      if (email && pass) {
        await db.runSuper(
          `INSERT INTO super_admins (email, password_hash, name, active) VALUES ($1, $2, 'Super Admin', TRUE)`,
          [email, hashPass(pass)]
        );
        logger.info('super_admin_bootstrap', { email, path: '/pages/super-admin.html', status: 'created' });
      }
    }
  } catch (e) {
    logger.error('super_admin_bootstrap_failed', {
      email: String(process.env.SUPER_ADMIN_EMAIL || '').trim().toLowerCase(),
      message: e.message
    });
  }

  const tenants = await db.runSuper('SELECT COUNT(*)::int AS c FROM tenants WHERE deleted_at IS NULL');
  logger.info('tenant_bootstrap', { tenant_count: tenants.rows[0].c, status: tenants.rows[0].c === 0 ? 'empty' : 'active' });
}

async function start() {
  await init();
  process.on('unhandledRejection', (reason) => {
    logger.error('unhandled_rejection', { message: reason && reason.stack ? reason.stack : String(reason) });
  });
  process.on('uncaughtException', (error) => {
    logger.error('uncaught_exception', {
      message: error && error.stack ? error.stack : String(error)
    });
    process.exitCode = 1;
  });

  /* Shutdown gracioso: loga a saída e fecha os pools do Postgres.
     Sem isso o container reinicia sem deixar rastro do motivo. */
  let shuttingDown = false;
  for (const signal of ['SIGTERM', 'SIGINT']) {
    process.on(signal, () => {
      if (shuttingDown) return;
      shuttingDown = true;
      logger.info('server_shutting_down', { signal, runtime: metrics.snapshot() });
      db.close()
        .then(() => process.exit(0))
        .catch(() => process.exit(0));
      // se o banco não fechar em 5s, sai mesmo assim
      setTimeout(() => process.exit(0), 5000).unref();
    });
  }

  return app.listen(PORT, () => {
    logger.info('server_started', {
      port: PORT,
      env: process.env.NODE_ENV || 'development',
      tenant_resolver: process.env.TENANT_RESOLVER || 'auto',
      dev_tenant_url: `http://localhost:${PORT}/?tenant=legado`,
      super_admin_url: `http://localhost:${PORT}/pages/super-admin.html`,
      log_level: process.env.LOG_LEVEL || (process.env.NODE_ENV === 'production' ? 'info' : 'debug')
    });
  });
}

if (require.main === module) {
  start().catch(err => {
    logger.error('server_start_failed', { message: err && err.message ? err.message : String(err) });
    process.exit(1);
  });
}

module.exports = { app, start, init, getTenantState, persistTenantState, invalidateTenantState, broadcast, publicState, adminState, isOpenNow, calcItemPrice, calcFreight };
