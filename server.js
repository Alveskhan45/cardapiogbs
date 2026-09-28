/* ============================================================
   Cardápio Digital — Backend Node.js + Express
   Serve o front (public/) + API REST + eventos em tempo real (SSE)
   Persistência local em arquivo JSON (data/db.json)
   ============================================================ */
const express = require('express');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const app = express();
const PORT = 3001;

const DATA_DIR = path.join(__dirname, 'data');
const DB_FILE = path.join(DATA_DIR, 'db.json');

/* ------------------- Helpers ------------------- */
const uid = () => '_' + Math.random().toString(36).slice(2, 9);

const brl = v => 'R$ ' + (Number(v) || 0).toFixed(2).replace('.', ',');

function makeTrackCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code = '';
  for (let i = 0; i < 5; i++) code += chars[Math.floor(Math.random() * chars.length)];
  return code;
}

function sha256(s) {
  return crypto.createHash('sha256').update('bebidas::' + s).digest('hex');
}

/* Hash de senha com scrypt (Node.js criptografia nativa, sem libs externas) */
function hashPass(pass) {
  const salt = crypto.randomBytes(16).toString('hex');
  const buf = crypto.scryptSync('bebidas::' + (pass || ''), salt, 64);
  return 'scrypt$' + salt + '$' + buf.toString('hex');
}

/* Senha inicial forte e aleatória. Não existe senha padrão neste projeto:
   o app gera uma na primeira execução e mostra no console uma única vez.
   Definir ADMIN_PASSWORD no ambiente também funciona. */
function generatePassword() {
  const chars = 'abcdefghijkmnopqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const bytes = crypto.randomBytes(16);
  let out = '';
  for (const b of bytes) out += chars[b % chars.length];
  return out;
}

function verifyPass(pass, stored) {
  const s = stored || '';
  if (!s) return false;
  if (s.startsWith('scrypt$')) {
    const parts = s.split('$');
    const salt = parts[1];
    const expected = Buffer.from(parts[2], 'hex');
    const got = crypto.scryptSync('bebidas::' + (pass || ''), salt, expected.length);
    return got.length === expected.length && crypto.timingSafeEqual(got, expected);
  }
  if (s.startsWith('sha256$')) {
    const expected = Buffer.from(s.slice(7), 'hex');
    const got = Buffer.from(sha256(pass), 'hex');
    return got.length === expected.length && crypto.timingSafeEqual(got, expected);
  }
  return s === pass;
}

/* Migração automática para o formato scrypt */
function passwordNeedsMigration(stored) {
  return !(stored || '').startsWith('scrypt$');
}

/* ------------------- Seed (dados iniciais) ------------------- */
function seedData() {
  return {
    products: [
      { id: uid(), name: 'Coca-Cola', desc: 'Refrigerante gelado', price: 6.00, promoPrice: null, cost: 2.5, category: 'Refrigerantes', stock: 40, image: '🥤', highlight: true, promo: false, active: true,
        variations: [{ name: 'Lata 350ml', price: 0 }, { name: 'PET 600ml', price: 2 }, { name: '2 Litros', price: 6 }],
        extras: [{ name: 'Copo com gelo', price: 1 }, { name: 'Limão extra', price: 0.5 }] },
      { id: uid(), name: 'Guaraná Antarctica', desc: 'Garrafa família', price: 12.00, promoPrice: 9.90, cost: 6, category: 'Refrigerantes', stock: 25, image: '🥤', highlight: false, promo: true, active: true,
        variations: [{ name: '1 Litro', price: 0 }, { name: '2 Litros', price: 3 }], extras: [] },
      { id: uid(), name: 'Suco de Laranja Natural', desc: 'Espremido na hora', price: 10.00, promoPrice: null, cost: 4, category: 'Sucos', stock: 15, image: '🍊', highlight: true, promo: false, active: true,
        variations: [{ name: '500ml', price: 0 }, { name: '1 Litro', price: 5 }],
        extras: [{ name: 'Sem açúcar', price: 0 }, { name: 'Com gelo', price: 0 }] },
      { id: uid(), name: 'Suco de Morango', desc: 'Natural, sem conservantes', price: 10.00, promoPrice: null, cost: 4, category: 'Sucos', stock: 12, image: '🍓', highlight: false, promo: false, active: true, variations: [], extras: [] },
      { id: uid(), name: 'Água Mineral', desc: 'Sem gás, gelada', price: 3.00, promoPrice: null, cost: 1, category: 'Águas', stock: 50, image: '💧', highlight: false, promo: false, active: true,
        variations: [{ name: '500ml', price: 0 }, { name: '1,5 Litro', price: 3 }], extras: [] },
      { id: uid(), name: 'Água com Gás', desc: 'Com gás, gelada', price: 4.00, promoPrice: null, cost: 1.2, category: 'Águas', stock: 30, image: '💧', highlight: false, promo: false, active: true, variations: [], extras: [] },
      { id: uid(), name: 'Heineken Long Neck', desc: '330ml, bem gelada', price: 9.90, promoPrice: null, cost: 5, category: 'Produto', stock: 24, image: '🍺', highlight: false, promo: false, active: true,
        variations: [{ name: 'Unidade', price: 0 }, { name: 'Pack 6', price: 45 }],
        extras: [{ name: 'Copo', price: 1 }] },
      { id: uid(), name: 'Brahma Lata', desc: '350ml, gelada', price: 5.00, promoPrice: 4.50, cost: 2.5, category: 'Produto', stock: 40, image: '🍺', highlight: false, promo: true, active: true, variations: [], extras: [] },
      { id: uid(), name: 'Red Bull', desc: 'Energético tradicional', price: 12.00, promoPrice: null, cost: 6, category: 'Energéticos', stock: 18, image: '⚡', highlight: true, promo: false, active: true, variations: [], extras: [] },
      { id: uid(), name: 'Vinho Tinto Reservado', desc: 'Cabernet Sauvignon', price: 45.00, promoPrice: null, cost: 22, category: 'Vinhos', stock: 8, image: '🍷', highlight: false, promo: false, active: true, variations: [], extras: [] }
    ],
    orders: [],
    coupons: [
      { id: uid(), code: 'BEMVINDO10', type: 'percent', value: 10, min: 20, active: true, uses: 0, limit: 0, per: 0, first: false },
      { id: uid(), code: 'FRETE5', type: 'fixed', value: 5, min: 30, active: true, uses: 0, limit: 0, per: 0, first: false },
      { id: uid(), code: 'LIVRE', type: 'frete', value: 0, min: 0, active: true, uses: 0, limit: 0, per: 0, first: false },
      { id: uid(), code: 'PRIMEIRA', type: 'percent', value: 15, min: 0, active: true, uses: 0, limit: 0, per: 0, first: true }
    ],
    categories: ['Refrigerantes', 'Sucos', 'Águas', 'Produto', 'Energéticos', 'Vinhos'],
    bairros: [
      { id: uid(), name: 'Centro', tax: 5, km: 2 },
      { id: uid(), name: 'Jardim Gurilândia', tax: 8, km: 4 },
      { id: uid(), name: 'Vila Nova', tax: 12, km: 7 }
    ],
    adminLog: [],
    stockLog: [],
    config: {
      storeName: 'Produto',
      slogan: 'Sua loja de produtos',
      whatsapp: '5585985708628',
      phone: '(85) 98570-8628',
      instagram: 'bebidasexemplo',
      address: 'Rua das estrelas, 1 - Jardim Paraíso',
      minOrder: 15,
      deliveryTime: '30-45 min',
      openTime: '18:00',
      closeTime: '23:00',
      days: 'Seg, Ter, Qua, Qui, Sex, Sáb, Dom',
      hours: 'Seg-Dom 18h-23h',
      freteMode: 'fixo',
      freteFixo: 5,
      freteKmVal: 2.5,
      freteKmGratis: 0,
      freteGratisAcima: 0,
      storeCoords: '',
      storeZip: '',
      storeStreet: '',
      storeNumber: '',
      storeDistrict: '',
      storeCity: '',
      storeBanner: '',
      payments: ['Pix', 'Dinheiro', 'Cartão na entrega'],
      pix: '',
      pixName: '',
      pixCity: '',
      requireAge: false,
      blockWhenClosed: false,
      minStock: 5,
      blockOutOfStock: false,
      showBanner: true,
      bannerShape: 'square',
      colorPrimary: '#d90429',
      colorPrimaryDark: '#a50320',
      themeAccent: '#ffb703',
      themeId: 'classic',
      autoBackup: true,
      lastAutoBackup: 0
    }
  };
}

/* ------------------- Banco de dados (arquivo JSON) ------------------- */
let db = null;

function loadDb() {
  try {
    if (fs.existsSync(DB_FILE)) {
      db = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
    }
  } catch (e) {
    console.error('Erro ao ler data/db.json:', e.message);
    db = null;
  }
  if (!db) {
    db = seedData();
    persistDb();
    console.log('Banco inicializado com dados de exemplo.');
  }
  // Sem hash gravado: cria uma senha forte e mostra no console UMA vez.
  // Depois disso a senha só existe como hash no data/db.json (fora do git)
  // e só muda pela aba Seguranca do painel.
  if (!db.config.adminPasswordHash) {
    const inicial = String(process.env.ADMIN_PASSWORD || db.config.adminPassword || '').trim() || generatePassword();
    db.config.adminPasswordHash = hashPass(inicial);
    persistDb();
    console.log('');
    console.log('  ============================================================');
    console.log('   SENHA INICIAL DO PAINEL (mostrada apenas nesta execucao)');
    console.log('   ' + inicial);
    console.log('   Anote agora. Para trocar, use o painel > Seguranca.');
    console.log('  ============================================================');
    console.log('');
  }
  delete db.config.adminPassword;
  const cfgDefaults = { pixName: '', pixCity: '', requireAge: false, blockWhenClosed: false, bannerShape: 'square', storeZip: '', storeStreet: '', storeNumber: '', storeDistrict: '', storeCity: '', storeBanner: '' };
  for (const k in cfgDefaults) if (db.config[k] === undefined) db.config[k] = cfgDefaults[k];
  if (db.config.bannerShape !== 'round') db.config.bannerShape = 'square';
  if (!Array.isArray(db.coupons)) db.coupons = [];
}

function persistDb() {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    const tmp = DB_FILE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(db, null, 2));
    fs.renameSync(tmp, DB_FILE);
  } catch (e) {
    console.error('Erro ao salvar banco:', e.message);
  }
}

/* Estado sem campos sensíveis de senha */
function sanitizeConfig(conf) {
  const c = Object.assign({}, conf);
  delete c.adminPasswordHash;
  delete c.adminPassword;
  return c;
}

function publicState() {
  return {
    products: db.products,
    categories: db.categories,
    bairros: db.bairros,
    coupons: db.coupons,
    config: sanitizeConfig(db.config)
  };
}

function adminState() {
  return {
    products: db.products,
    orders: db.orders,
    coupons: db.coupons,
    categories: db.categories,
    bairros: db.bairros,
    adminLog: db.adminLog,
    stockLog: db.stockLog,
    config: sanitizeConfig(db.config)
  };
}

/* ------------------- Autenticação ------------------- */
const TOKEN_TTL = 30 * 24 * 60 * 60 * 1000; // 30 dias
const tokens = new Map(); // token -> {at}

function issueToken() {
  const t = crypto.randomBytes(24).toString('hex');
  tokens.set(t, { at: Date.now() });
  return t;
}

function isTokenValid(t) {
  const rec = tokens.get(t);
  if (!rec) return false;
  if (Date.now() - rec.at > TOKEN_TTL) { tokens.delete(t); return false; }
  return true;
}

function requireAdmin(req, res, next) {
  const t = req.headers['x-token'];
  if (!isTokenValid(t)) return res.status(401).json({ ok: false, error: 'Não autorizado' });
  next();
}

app.use(express.json({ limit: '2mb' }));
app.use((req, res, next) => {
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Expires', '0');
  next();
});
app.use(express.static(path.join(__dirname, 'public')));

/* ------------------- Eventos em tempo real (SSE) ------------------- */
const sseClients = new Set();

function broadcast(event, data) {
  const msg = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  sseClients.forEach(c => {
    try { c.write(msg); } catch (e) { sseClients.delete(c); }
  });
}

app.get('/api/events', (req, res) => {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive'
  });
  res.write('retry: 3000\n\n');
  sseClients.add(res);
  req.on('close', () => sseClients.delete(res));
});

/* ------------------- API: saúde ------------------- */
app.get('/api/health', (req, res) => {
  res.json({ ok: true, time: Date.now() });
});

/* ------------------- API: público (cardápio) ------------------- */
app.get('/api/public', (req, res) => {
  res.json({ ok: true, state: publicState() });
});

/* ------------------- Horário de funcionamento ------------------- */
const DAY_MAP = { seg: 1, ter: 2, qua: 3, qui: 4, sex: 5, sab: 6, dom: 0, 'segunda': 1, 'terça': 2, 'terca': 2, 'quarta': 3, 'quinta': 4, 'sexta': 5, 'sábado': 6, 'sabado': 6, 'domingo': 0 };

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
  const todayName = ['dom', 'seg', 'ter', 'qua', 'qui', 'sex', 'sab'][now.getDay()];
  const days = String(cfg.days).split(',').map(s => DAY_MAP[String(s).trim().toLowerCase()]);
  if (!days.includes(now.getDay()) && !days.includes(todayName)) return false;
  if (close <= open) return cur >= open || cur < close; // atravessa a meia-noite
  return cur >= open && cur < close;
}

/* ------------------- Rate limit simples (memória) ------------------- */
const rateBuckets = new Map();

function rateLimitCheck(key, max, windowMs) {
  const now = Date.now();
  const rec = rateBuckets.get(key);
  if (!rec || now - rec.start > windowMs) {
    rateBuckets.set(key, { start: now, n: 1 });
    return true;
  }
  rec.n++;
  return rec.n <= max;
}

/* ------------------- API: pedidos ------------------- */
app.get('/api/orders/:id', (req, res) => {
  const o = db.orders.find(x => String(x.id) === String(req.params.id));
  if (!o) return res.status(404).json({ ok: false, error: 'Pedido não encontrado' });
  res.json({ ok: true, status: o.status });
});

function calcItemPrice(p, variation, extras) {
  const base = p.promo && p.promoPrice ? p.promoPrice : p.price;
  const vPrice = variation ? Number(variation.price) || 0 : null;
  const eAdd = (extras || []).reduce((s, e) => s + (Number(e.price) || 0), 0);
  const finalBase = vPrice !== null ? vPrice : base;
  return finalBase + eAdd;
}

function calcFreight(subtotal, opts) {
  const cfg = db.config;
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
      const b = db.bairros.find(x => x.id === opts.bairroId);
      return b ? Number(b.tax) || 0 : 0;
    }
    default: return Number(cfg.freteFixo) || 0;
  }
}

app.post('/api/orders', (req, res) => {
  const body = req.body || {};
  const cfg = db.config;

  if (!rateLimitCheck('orders:' + req.ip, 10, 60 * 1000)) {
    return res.status(429).json({ ok: false, error: 'Muitos pedidos em pouco tempo. Aguarde um instante.' });
  }
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
    const p = db.products.find(x => x.id === it.id && x.active !== false);
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
      variation: variation ? variation.name : '',
      extras: extras.map(e => e.name),
      obs: String(it.obs || ''),
      qty,
      unit: +unit.toFixed(2),
      total: +(unit * qty).toFixed(2)
    });
  }

  const subtotal = +items.reduce((s, i) => s + i.total, 0).toFixed(2);

  /* --- cupom (dá desconto opcional, frete grátis ou validações avançadas) --- */
  let discount = 0;
  let couponCode = '';
  let freeFreight = false;
  if (body.coupon) {
    const coupon = db.coupons.find(c => c.code.toUpperCase() === String(body.coupon).toUpperCase() && c.active);
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
      if (coupon.first && phone && db.orders.some(o => o.phone && o.phone === phone)) {
        return res.json({ ok: false, code: 'COUPON_FIRST', error: 'Este cupom é só para a primeira compra' });
      }
      if (Number(coupon.per) > 0 && phone) {
        const usedByCust = db.orders.filter(o => o.phone === phone && o.coupon === String(coupon.code).toUpperCase()).length;
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
    return res.status(400).json({ ok: false, code: 'MIN_ORDER', error: `Pedido mínimo ${cfg.minOrder}` });
  }

  const deliveryBase = type === 'Retirada' ? 0 : calcFreight(subAfterDiscount, { type, bairroId, km });
  const delivery = freeFreight && type !== 'Retirada' ? 0 : deliveryBase;
  const total = +(subAfterDiscount + delivery).toFixed(2);

  const bairroName = bairroId ? (db.bairros.find(b => b.id === bairroId)?.name || '') : '';

  const order = {
    id: Date.now() + Math.floor(Math.random() * 100),
    trackCode: makeTrackCode(),
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

  /* --- aplica efeitos: estoque e uso de cupom --- */
  items.forEach(i => {
    const p = db.products.find(x => x.name === i.name);
    if (p) p.stock = Math.max(0, p.stock - i.qty);
  });
  if (couponCode) {
    const c = db.coupons.find(c => c.code === couponCode);
    if (c) c.uses = (c.uses || 0) + 1;
  }

  db.orders.unshift(order);
  persistDb();
  broadcast('sync', { t: Date.now() });

  res.json({ ok: true, order, waUrl: `/api/orders/${order.id}/wa` });
});

/* Gera o link do WhatsApp pronto para o pedido (recalculado no servidor) */
app.get('/api/orders/:id/wa', (req, res) => {
  const o = db.orders.find(x => String(x.id) === String(req.params.id));
  if (!o) return res.status(404).json({ ok: false, error: 'Pedido não encontrado' });
  const brl = v => 'R$ ' + (Number(v) || 0).toFixed(2).replace('.', ',');
  const cfg = db.config;
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
  o.items.forEach(i => {
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
});

/* ------------------- API: admin ------------------- */
app.get('/api/track/:code', (req, res) => {
  const code = String(req.params.code || '').toUpperCase();
  const o = db.orders.find(x => String(x.trackCode || '').toUpperCase() === code);
  if (!o) return res.status(404).json({ ok: false, error: 'Pedido não encontrado' });
  res.json({ ok: true, order: { id: o.id, status: o.status, statusLabel: o.status, createdAt: o.createdAt, statusUpdatedAt: o.statusUpdatedAt || o.createdAt, total: o.total, trackCode: o.trackCode } });
});

app.get('/acompanhar', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.post('/api/login', (req, res) => {
  if (!rateLimitCheck('login:' + req.ip, 10, 15 * 60 * 1000)) {
    return res.status(429).json({ ok: false, error: 'Muitas tentativas. Aguarde alguns minutos.' });
  }
  const pass = String((req.body && req.body.password) || '');
  const stored = db.config.adminPasswordHash || '';
  if (!verifyPass(pass, stored)) {
    return res.status(401).json({ ok: false, error: 'Senha incorreta' });
  }
  if (passwordNeedsMigration(stored)) {
    db.config.adminPasswordHash = hashPass(pass);
    persistDb();
  }
  res.json({ ok: true, token: issueToken(), state: adminState() });
});

app.post('/api/logout', requireAdmin, (req, res) => {
  const t = req.headers['x-token'];
  tokens.delete(t);
  res.json({ ok: true });
});

app.get('/api/admin/state', requireAdmin, (req, res) => {
  res.json({ ok: true, state: adminState() });
});

app.put('/api/admin/state', requireAdmin, (req, res) => {
  const s = req.body || {};
  const hash = db.config.adminPasswordHash;
  const incomingConfig = Object.assign({}, s.config);
  const mergedConfig = Object.assign({}, db.config, incomingConfig, { adminPasswordHash: hash });
  delete mergedConfig.adminPassword;

  db.products = Array.isArray(s.products) ? s.products : db.products;
  db.orders = (Array.isArray(s.orders) && (db.orders.length === 0 || s.orders.length > 0)) ? s.orders : db.orders;
  db.coupons = Array.isArray(s.coupons) ? s.coupons : db.coupons;
  db.categories = Array.isArray(s.categories) ? s.categories : db.categories;
  db.bairros = Array.isArray(s.bairros) ? s.bairros : db.bairros;
  db.adminLog = Array.isArray(s.adminLog) ? s.adminLog : db.adminLog;
  db.stockLog = Array.isArray(s.stockLog) ? s.stockLog : db.stockLog;
  db.config = mergedConfig;

  persistDb();
  broadcast('sync', { t: Date.now() });
  res.json({ ok: true });
});

app.post('/api/admin/password', requireAdmin, (req, res) => {
  const old = String((req.body && req.body.old) || '');
  const next = String((req.body && req.body.new) || '');
  const stored = db.config.adminPasswordHash || '';
  if (!verifyPass(old, stored)) return res.status(400).json({ ok: false, error: 'Senha atual incorreta' });
  if (next.length < 4) return res.status(400).json({ ok: false, error: 'Senha muito curta (mín. 4)' });
  db.config.adminPasswordHash = hashPass(next);
  persistDb();
  broadcast('sync', { t: Date.now() });
  res.json({ ok: true, adminPasswordHash: db.config.adminPasswordHash });
});

/* ------------------- Boot ------------------- */
loadDb();

app.listen(PORT, () => {
  console.log(`🛒 Cardápio Digital rodando em http://localhost:${PORT}`);
  console.log(`   Painel admin: http://localhost:${PORT}`);
});