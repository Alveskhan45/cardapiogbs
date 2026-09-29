/* ==================== ESTADO GLOBAL v6 ==================== */
const KEY = 'bebidas_cardapio_v6';

let state = {
  products: [],
  orders: [],
  cart: [],
  coupons: [],
  categories: [],
  bairros: [],
  adminLog: [],
  stockLog: [],
  config: {
    storeName: 'Produto',
    slogan: 'Sua loja de produtos',
    whatsapp: '5585987745402',
    phone: '(85) 98774-5402',
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
    payments: ['Pix','Dinheiro','Cartão na entrega'],
    pix: '',
    minStock: 5,
    blockOutOfStock: false,
    showBanner: true,
    bannerShape: 'square',
    colorPrimary: '#d90429',
    colorPrimaryDark: '#a50320',
    themeAccent: '#ffb703',
    themeId: 'classic',
    pixName: '',
    pixCity: '',
    requireAge: false,
    blockWhenClosed: false,
    adminPasswordHash: '',
    autoBackup: true,
    lastAutoBackup: 0
  }
};

const $ = id => document.getElementById(id);
const uid = () => '_' + Math.random().toString(36).slice(2,9);
const brl = v => 'R$ ' + (Number(v)||0).toFixed(2).replace('.',',');

/* Escapa texto para uso dentro de HTML/atributos. Toda string que venha do
   cliente (pedido, observação, busca) ou do config passa por aqui antes de ir
   para innerHTML — é a defesa contra XSS armazenado. */
function esc(s) {
  if (s == null) return '';
  return String(s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}
const localDay = iso => new Date(new Date(iso).getTime() - 3*3600*1000).toISOString().slice(0,10);

const cepDigits = v => String(v || '').replace(/\D/g, '');
const maskCep = v => {
  const d = cepDigits(v);
  return d.length === 8 ? d.slice(0,5) + '-' + d.slice(5) : d;
};
function mapsUrl(target) {
  const t = String(target || '').trim();
  return t ? 'https://www.google.com/maps/search/?api=1&query=' + encodeURIComponent(t) : '';
}

/* Endereço da loja montado a partir das partes (rua, número, bairro, cidade).
   É isso que aparece no cardápio e o que o mapa procura — com o número, para
   cair na frente do estabelecimento em vez do meio da rua. */
function storeAddressLabel(c) {
  const cfg = c || state.config || {};
  const street = String(cfg.storeStreet || '').trim();
  const number = String(cfg.storeNumber || '').trim();
  const district = String(cfg.storeDistrict || '').trim();
  const city = String(cfg.storeCity || '').trim();
  if (!street && !number && !district && !city) return '';
  const line1 = [street, number].filter(Boolean).join(', ');
  return [line1, [district, city].filter(Boolean).join(' - ')]
    .filter(Boolean).join(' - ');
}

/* Alvo do link do mapa: endereço completo (inclui o número) > CEP > coordenadas. */
function mapsTargetFromConfig(c) {
  const cfg = c || state.config || {};
  const addr = storeAddressLabel(cfg) || String(cfg.address || '').trim();
  if (addr) return addr;
  const z = cepDigits(cfg.storeZip);
  if (z.length === 8) return maskCep(z);
  const p = String(cfg.storeCoords || '').split(',').map(x => parseFloat(x.trim()));
  if (p.length === 2 && !isNaN(p[0]) && !isNaN(p[1])) return p[0] + ',' + p[1];
  return '';
}

function toast(msg, ms=2200) {
  const t = $('toast');
  if (!t) return;
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toast._t);
  toast._t = setTimeout(() => t.classList.remove('show'), ms);
}

function closeAll() {
  if (typeof _confirmCancel === 'function') _confirmCancel();
  document.querySelectorAll('.overlay').forEach(o => o.classList.remove('open'));
}

/* ==================== AUTO-BACKUP ==================== */
const BACKUP_MAX = 4;
const BACKUP_INTERVAL = 6 * 60 * 60 * 1000;
const bkKey = n => KEY + '_auto_' + n;

function save() {
  saveLocalOnly();
  if (state.config.autoBackup !== false) maybeAutoBackup();
  scheduleServerPush();
}

async function pushStateNow() {
  if (!window.__HAS_BACKEND__) return;
  if (_pushTimer) { clearTimeout(_pushTimer); _pushTimer = null; }
  const res = await api('/api/admin/state', { method: 'PUT', body: serverPayload() });
  if (res && res.ok === false && (res.error === 'Não autorizado' || res.status === 401)) {
    setToken('');
  }
}

function maybeAutoBackup() {
  const now = Date.now();
  const last = state.config.lastAutoBackup || 0;
  if (now - last < BACKUP_INTERVAL) return;
  state.config.lastAutoBackup = now;
  const snap = { at: new Date().toISOString(), data: state };
  try {
    localStorage.removeItem(bkKey(BACKUP_MAX));
    for (let i = BACKUP_MAX - 1; i >= 1; i--) {
      const v = localStorage.getItem(bkKey(i));
      if (v) localStorage.setItem(bkKey(i + 1), v);
    }
    localStorage.setItem(bkKey(1), JSON.stringify(snap));
  } catch (e) { console.warn('Auto-backup falhou:', e); }
  try { localStorage.setItem(KEY, JSON.stringify(state)); } catch (e) {}
}

/* ==================== SINCRONIZAÇÃO ==================== */
const TOKEN_KEY = KEY + '_admin_token';
let SERVER_OK = false;

/* Mantém o pílula "online/offline" do topo sincronizada com o estado real.
   Antes SERVER_OK só subia e a interface nunca era repintada. */
function setServerOk(v) {
  v = !!v;
  if (SERVER_OK === v) return;
  SERVER_OK = v;
  if (typeof setConnUI === 'function') setConnUI(v ? 'on' : 'off');
}
let _pushTimer = null;

function getToken() { return localStorage.getItem(TOKEN_KEY) || ''; }
function setToken(t) { t ? localStorage.setItem(TOKEN_KEY, t) : localStorage.removeItem(TOKEN_KEY); }

async function api(path, opts = {}) {
  const o = Object.assign({}, opts);
  o.headers = Object.assign({}, opts.headers || {});
  if (o.body && !(o.body instanceof FormData)) {
    o.headers['Content-Type'] = 'application/json';
    o.body = JSON.stringify(o.body);
  }
  const t = getToken();
  if (t && !o.headers['x-token']) o.headers['x-token'] = t;

  // Sem timeout, um fetch que nunca responde trava a promessa — e em load()
  // isso deixava a página presa em "Carregando cardápio..." para sempre.
  const ms = Number(o.timeout) || 20000;
  delete o.timeout;
  const ctrl = typeof AbortController !== 'undefined' ? new AbortController() : null;
  if (ctrl) {
    o.signal = ctrl.signal;
    o.__timer = setTimeout(() => ctrl.abort(), ms);
  }
  try {
    const r = await fetch(path, o);
    let body = null;
    try { body = await r.json(); }
    catch (e) { body = { ok: false, error: 'Resposta inválida do servidor' }; }
    if (body && typeof body === 'object') body.status = r.status;
    return body;
  } catch (e) {
    /* null = rede fora / timeout. Quem chama precisa distinguir disso de um
       erro do servidor (que vem como objeto com .status). */
    return null;
  } finally {
    if (ctrl) clearTimeout(o.__timer);
    delete o.__timer;
  }
}

function serverPayload() {
  const cfg = Object.assign({}, state.config);
  delete cfg.adminPassword;
  delete cfg.adminPasswordHash;
  return {
    products: state.products,
    orders: state.orders,
    coupons: state.coupons,
    categories: state.categories,
    bairros: state.bairros,
    adminLog: state.adminLog,
    stockLog: state.stockLog,
    config: cfg
  };
}

function applyServerState(data) {
  if (!data) return;
  if (Array.isArray(data.products)) state.products = data.products;
  if (Array.isArray(data.orders)) state.orders = data.orders;
  if (Array.isArray(data.coupons)) state.coupons = data.coupons;
  if (Array.isArray(data.categories)) state.categories = data.categories;
  if (Array.isArray(data.bairros)) state.bairros = data.bairros;
  if (Array.isArray(data.adminLog)) state.adminLog = data.adminLog;
  if (Array.isArray(data.stockLog)) state.stockLog = data.stockLog;
  if (data.config) {
    const localHash = state.config.adminPasswordHash;
    state.config = Object.assign({}, state.config, data.config);
    if (localHash) state.config.adminPasswordHash = localHash;
  }
}

function saveLocalOnly() {
  try {
    localStorage.setItem(KEY, JSON.stringify(state));
  } catch (e) {
    /* QuotaExceeded (banner base64 enche o armazenamento): avisar em vez de
       deixar a exceção estourar na função que chamou save(). */
    toast('⚠️ Espaço do navegador cheio — não consegui salvar localmente', 5000);
  }
}

function scheduleServerPush() {
  if (typeof adminUnlocked !== 'undefined' && adminUnlocked === false) return;
  if (_pushTimer) clearTimeout(_pushTimer);
  _pushTimer = setTimeout(pushState, 600);
}

async function pushState() {
  _pushTimer = null;
  if (!window.__HAS_BACKEND__) return;
  const res = await api('/api/admin/state', { method: 'PUT', body: serverPayload() });
  if (res && res.ok === false && (res.error === 'Não autorizado' || res.status === 401)) {
    setToken('');
  }
  /* null = falha de rede/timeout: derruba o indicador em vez de fingir online */
  if (!res) setServerOk(false);
}

async function pullPublic() {
  if (!window.__HAS_BACKEND__) return false;
  const res = await api('/api/public', { method: 'GET' });
  if (res && res.ok && res.state) {
    applyServerState(res.state);
    saveLocalOnly();
    setServerOk(true);
    if (typeof renderContactInfo === 'function') renderContactInfo();
    return true;
  }
  setServerOk(false);
  return false;
}

/* Assinatura do que o cliente enxerga — evita re-renderizar a interface
   quando nada mudou de fato no servidor. */
function clientStateSignature() {
  const c = state.config;
  return JSON.stringify([
    c.storeCoords, c.storeZip, c.address, c.minOrder, c.freteMode, c.freteFixo,
    c.freteKmVal, c.freteKmGratis, c.freteGratisAcima, c.bannerShape, c.colorPrimary,
    c.colorPrimaryDark, c.blockWhenClosed, c.openTime, c.closeTime, c.hours,
    state.products.length,
    state.products.map(p => p.id + ':' + p.price + ':' + p.stock + ':' + (p.active ? 1 : 0)).join(','),
    state.categories.join('|')
  ]);
}

let configWatchTimer = null;

/* Clientes (fora do painel) não têm SSE nem polling: sem isso, uma alteração
   feita pelo lojista — como a localização da loja — só chegaria no próximo
   recarregamento, e o cardápio continuaria calculando frete com o valor antigo. */
function startConfigWatch() {
  if (typeof isAdminUnlocked === 'function' && isAdminUnlocked()) return;
  if (configWatchTimer) clearInterval(configWatchTimer);
  const ms = Math.max(30000, Number(state.config.pollingMs) || 60000);
  let lastSig = clientStateSignature();

  configWatchTimer = setInterval(async () => {
    if (document.hidden) return;
    const coordsBefore = state.config.storeCoords;
    const okPull = await pullPublic();
    if (!okPull) return;

    const sig = clientStateSignature();
    if (sig === lastSig) return;
    lastSig = sig;

    // A loja mudou de lugar: a distância já calculada vale mais nada.
    if (state.config.storeCoords !== coordsBefore) {
      const kmIn = $('cKmF');
      if (kmIn) kmIn.value = '';
      if (typeof useCustomerLocation === 'function') useCustomerLocation();
    }

    if (typeof renderMenu === 'function') renderMenu();
    if (typeof renderStatus === 'function') renderStatus();
    if (typeof renderContactInfo === 'function') renderContactInfo();
    if (typeof renderCart === 'function') renderCart();
  }, ms);
}

async function pullAdmin() {
  if (!window.__HAS_BACKEND__) return false;
  const res = await api('/api/admin/state', { method: 'GET' });
  if (res && res.ok && res.state) {
    applyServerState(res.state);
    saveLocalOnly();
    setServerOk(true);
    if (typeof renderContactInfo === 'function') renderContactInfo();
    return true;
  }
  setServerOk(false);
  return false;
}

async function refreshFromServer() {
  saveLocalOnly();
  return getToken() ? pullAdmin() : pullPublic();
}

function listAutoBackups() {
  const out = [];
  for (let i = 1; i <= BACKUP_MAX; i++) {
    const raw = localStorage.getItem(bkKey(i));
    if (!raw) continue;
    try {
      const snap = JSON.parse(raw);
      out.push({ key: bkKey(i), at: snap.at, data: snap.data });
    } catch (e) {}
  }
  return out;
}

function downloadAutoBackup(data) {
  try {
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `backup-${new Date().toISOString().slice(0,10)}.json`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  } catch (e) {
    toast('Erro ao baixar backup');
  }
}

async function restoreAutoBackup(key) {
  const raw = localStorage.getItem(key);
  if (!raw) return false;
  let snap;
  try { snap = JSON.parse(raw); } catch (e) { return false; }
  const data = snap.data || snap;
  const msg = `Restaurar o backup de ${snap.at ? new Date(snap.at).toLocaleString('pt-BR') : 'data desconhecida'}?\nOs dados atuais serão substituídos.`;
  const ok = await new Promise(resolve =>
    showConfirm(msg, () => resolve(true), 'Confirmar', () => resolve(false)));
  if (!ok) return false;
  state = Object.assign({}, state, data, { adminLog: data.adminLog || [], stockLog: data.stockLog || [] });
  save();
  if (typeof renderCats === 'function') renderCats();
  if (typeof renderCart === 'function') renderCart();
  if (typeof renderAdmin === 'function') renderAdmin();
  toast('✅ Backup restaurado');
  return true;
}

/* ==================== HORÁRIO ==================== */
const DIAS_PT = ['dom','seg','ter','qua','qui','sex','sab'];
const normKey = s => (s||'').normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLowerCase().trim();

function isStoreOpen() {
  const c = state.config;
  if (!c.openTime || !c.closeTime) return true;
  const now = new Date();
  const todayKey = DIAS_PT[now.getDay()];
  const days = (c.days || '').trim();
  if (days) {
    const inDays = days.split(',').map(d => normKey(d).slice(0,3)).includes(todayKey);
    if (!inDays) return false;
  }
  const [oh, om] = c.openTime.split(':').map(Number);
  const [ch, cm] = c.closeTime.split(':').map(Number);
  const cur = now.getHours() * 60 + now.getMinutes();
  const open = oh * 60 + om;
  const close = ch * 60 + cm;
  if (open === close) return true;
  return close > open ? (cur >= open && cur < close) : (cur >= open || cur < close);
}

/* ==================== SENHA ==================== */
function hashPass(pass) {
  const input = 'bebidas::' + (pass || '');
  if (typeof crypto !== 'undefined' && crypto.subtle) {
    return crypto.subtle.digest('SHA-256', new TextEncoder().encode(input))
      .then(buf => 'sha256$' + [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2,'0')).join(''));
  }
  return Promise.resolve('plain$' + input);
}

function verifyPass(pass, stored) {
  const s = stored || '';
  if (!s) return Promise.resolve(false);
  if (s.indexOf('sha256$') === 0) {
    return hashPass(pass).then(h => h === s);
  }
  if (s.indexOf('plain$') === 0) {
    return Promise.resolve(s === 'plain$bebidas::' + (pass || ''));
  }
  return Promise.resolve(s === pass);
}

async function load() {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) state = Object.assign({}, state, JSON.parse(raw));
  } catch(e){ console.warn(e); }

  // A detecção de backend é assíncrona: sem esperar, load() podia concluir antes
  // dela e o app cair no modo offline com dados velhos do localStorage.
  try { await backendReady; } catch (e) {}

  const online = await pullPublic();

  if (!online) {
    if (!state.products || !state.products.length) seed();
    else mergeSeed();
  }

  if (!state.categories || !state.categories.length) {
    state.categories = [...new Set(state.products.map(p=>p.category).filter(Boolean))];
  }
  if (!state.bairros) state.bairros = [];
  if (!state.adminLog) state.adminLog = [];
  if (!state.stockLog) state.stockLog = [];
  if (state.config.autoBackup === undefined) state.config.autoBackup = true;
  if (state.config.pollingMs === undefined) state.config.pollingMs = 15000;
  state.config.pixName = state.config.pixName || '';
  state.config.pixCity = state.config.pixCity || '';
  state.config.requireAge = !!state.config.requireAge;
  state.config.blockWhenClosed = !!state.config.blockWhenClosed;
  state.config.bannerShape = state.config.bannerShape === 'round' ? 'round' : 'square';
}

const SEED_PRODUCTS = [
    { id:uid(), name:'Coca-Cola', desc:'Refrigerante gelado', price:6.00, promoPrice:null, cost:2.5, category:'Refrigerantes', stock:40, image:'🥤', highlight:true, promo:false, active:true,
      variations:[{name:'Lata 350ml',price:0},{name:'PET 600ml',price:2},{name:'2 Litros',price:6}],
      extras:[{name:'Copo com gelo',price:1},{name:'Limão extra',price:0.5}] },
    { id:uid(), name:'Guaraná Antarctica', desc:'Garrafa família', price:12.00, promoPrice:9.90, cost:6, category:'Refrigerantes', stock:25, image:'🥤', highlight:false, promo:true, active:true,
      variations:[{name:'1 Litro',price:0},{name:'2 Litros',price:3}], extras:[] },
    { id:uid(), name:'Fanta Laranja', desc:'Lata 350ml bem gelada', price:6.00, promoPrice:null, cost:2.5, category:'Refrigerantes', stock:35, image:'🍊', highlight:false, promo:false, active:true, variations:[], extras:[] },
    { id:uid(), name:'Sprite', desc:'O limão que é uma uva', price:6.00, promoPrice:null, cost:2.5, category:'Refrigerantes', stock:30, image:'🥤', highlight:false, promo:false, active:true,
      variations:[{name:'Lata 350ml',price:0},{name:'PET 600ml',price:2}], extras:[] },
    { id:uid(), name:'Coca-Cola Zero', desc:'Sem açúcar, mesmo sabor', price:6.00, promoPrice:null, cost:2.5, category:'Refrigerantes', stock:28, image:'🥤', highlight:false, promo:false, active:true, variations:[], extras:[] },
    { id:uid(), name:'Suco de Laranja Natural', desc:'Espremido na hora', price:10.00, promoPrice:null, cost:4, category:'Sucos', stock:15, image:'🍊', highlight:true, promo:false, active:true,
      variations:[{name:'500ml',price:0},{name:'1 Litro',price:5}],
      extras:[{name:'Sem açúcar',price:0},{name:'Com gelo',price:0}] },
    { id:uid(), name:'Suco de Morango', desc:'Natural, sem conservantes', price:10.00, promoPrice:null, cost:4, category:'Sucos', stock:12, image:'🍓', highlight:false, promo:false, active:true, variations:[], extras:[] },
    { id:uid(), name:'Suco de Abacaxi', desc:'Fresco e docinho', price:9.00, promoPrice:null, cost:3.5, category:'Sucos', stock:14, image:'🍍', highlight:false, promo:false, active:true, variations:[], extras:[] },
    { id:uid(), name:'Suco de Limão', desc:'Com ou sem açúcar', price:8.00, promoPrice:null, cost:3, category:'Sucos', stock:16, image:'🍋', highlight:false, promo:false, active:true, variations:[], extras:[] },
    { id:uid(), name:'Suco de Uva Integral', desc:'Uva 100% natural', price:12.00, promoPrice:null, cost:6, category:'Sucos', stock:10, image:'🍇', highlight:true, promo:false, active:true, variations:[], extras:[] },
    { id:uid(), name:'Água Mineral', desc:'Sem gás, gelada', price:3.00, promoPrice:null, cost:1, category:'Águas', stock:50, image:'💧', highlight:false, promo:false, active:true,
      variations:[{name:'500ml',price:0},{name:'1,5 Litro',price:3}], extras:[] },
    { id:uid(), name:'Água com Gás', desc:'Com gás, gelada', price:4.00, promoPrice:null, cost:1.2, category:'Águas', stock:30, image:'💧', highlight:false, promo:false, active:true, variations:[], extras:[] },
    { id:uid(), name:'Água de Coco', desc:'Natural, bem gelada', price:8.00, promoPrice:null, cost:4, category:'Águas', stock:18, image:'🥥', highlight:false, promo:false, active:true, variations:[], extras:[] },
    { id:uid(), name:'Heineken Long Neck', desc:'330ml, bem gelada', price:9.90, promoPrice:null, cost:5, category:'Produto', stock:24, image:'🍺', highlight:false, promo:false, active:true,
      variations:[{name:'Unidade',price:0},{name:'Pack 6',price:45}],
      extras:[{name:'Copo',price:1}] },
    { id:uid(), name:'Brahma Lata', desc:'350ml, gelada', price:5.00, promoPrice:4.50, cost:2.5, category:'Produto', stock:40, image:'🍺', highlight:false, promo:true, active:true, variations:[], extras:[] },
    { id:uid(), name:'Skol Lata', desc:'Mantida a 0°, gelada', price:5.00, promoPrice:4.20, cost:2.5, category:'Produto', stock:38, image:'🍺', highlight:false, promo:true, active:true, variations:[], extras:[] },
    { id:uid(), name:'Original 600ml', desc:'A cerveja do verão', price:12.90, promoPrice:null, cost:7, category:'Produto', stock:20, image:'🍺', highlight:true, promo:false, active:true, variations:[], extras:[] },
    { id:uid(), name:'Stella Artois', desc:'Long neck 330ml', price:11.00, promoPrice:null, cost:6, category:'Produto', stock:22, image:'🍺', highlight:false, promo:false, active:true, variations:[], extras:[] },
    { id:uid(), name:'Budweiser Lata', desc:'Simplesmente melhor', price:6.00, promoPrice:null, cost:3, category:'Produto', stock:30, image:'🍺', highlight:false, promo:false, active:true, variations:[], extras:[] },
    { id:uid(), name:'Corona Extra', desc:'Long neck importada', price:12.00, promoPrice:null, cost:7, category:'Produto', stock:15, image:'🍺', highlight:false, promo:false, active:true,
      variations:[{name:'Unidade',price:0},{name:'Com limão',price:0}], extras:[] },
    { id:uid(), name:'Red Bull', desc:'Energético tradicional', price:12.00, promoPrice:null, cost:6, category:'Energéticos', stock:18, image:'⚡', highlight:true, promo:false, active:true, variations:[], extras:[] },
    { id:uid(), name:'Red Bull Sugar Free', desc:'Sem açúcar, mesma onda', price:12.50, promoPrice:null, cost:6.5, category:'Energéticos', stock:12, image:'⚡', highlight:false, promo:false, active:true, variations:[], extras:[] },
    { id:uid(), name:'Monster Energy', desc:'Lata 473ml original', price:15.00, promoPrice:13.90, cost:8, category:'Energéticos', stock:16, image:'⚡', highlight:false, promo:true, active:true, variations:[], extras:[] },
    { id:uid(), name:'Monster Ultra', desc:'Sem açúcar, branca', price:15.00, promoPrice:null, cost:8, category:'Energéticos', stock:14, image:'⚡', highlight:false, promo:false, active:true, variations:[], extras:[] },
    { id:uid(), name:'TNT Energy', desc:'Vírus da agitação', price:8.00, promoPrice:null, cost:4, category:'Energéticos', stock:20, image:'⚡', highlight:false, promo:false, active:true, variations:[], extras:[] },
    { id:uid(), name:'Vinho Tinto Reservado', desc:'Cabernet Sauvignon', price:45.00, promoPrice:null, cost:22, category:'Vinhos', stock:8, image:'🍷', highlight:false, promo:false, active:true, variations:[], extras:[] },
    { id:uid(), name:'Vinho Branco Chardonnay', desc:'Nacional, leve', price:40.00, promoPrice:null, cost:20, category:'Vinhos', stock:7, image:'🍷', highlight:false, promo:false, active:true, variations:[], extras:[] },
    { id:uid(), name:'Vinho Rosé', desc:'Suave e fresco', price:38.00, promoPrice:32.90, cost:18, category:'Vinhos', stock:6, image:'🍷', highlight:false, promo:true, active:true, variations:[], extras:[] },
    { id:uid(), name:'Espumante Brut', desc:'Pra brindar', price:55.00, promoPrice:null, cost:28, category:'Vinhos', stock:5, image:'🍾', highlight:true, promo:false, active:true, variations:[], extras:[] },
    { id:uid(), name:'Cachaça 51', desc:'Garrafa 965ml', price:45.00, promoPrice:null, cost:22, category:'Destilados', stock:10, image:'🥃', highlight:false, promo:false, active:true, variations:[], extras:[] },
    { id:uid(), name:'Vodka Smirnoff', desc:'Garrafa 1L', price:50.00, promoPrice:null, cost:24, category:'Destilados', stock:9, image:'🥃', highlight:true, promo:false, active:true,
      variations:[{name:'Tradicional',price:0},{name:'Citrus',price:0}], extras:[] },
    { id:uid(), name:'Whisky Red Label', desc:'Johnnie Walker 1L', price:145.00, promoPrice:null, cost:80, category:'Destilados', stock:6, image:'🥃', highlight:false, promo:false, active:true, variations:[], extras:[] },
    { id:uid(), name:'Gin Tanqueray', desc:'Agora em 750ml', price:130.00, promoPrice:null, cost:70, category:'Destilados', stock:5, image:'🥃', highlight:false, promo:false, active:true, variations:[], extras:[] },
    { id:uid(), name:'Tequila José Cuervo', desc:'Prata 750ml', price:95.00, promoPrice:null, cost:50, category:'Destilados', stock:4, image:'🥃', highlight:false, promo:false, active:true, variations:[], extras:[] },
    { id:uid(), name:'Combo Brahma', desc:'10 latas 350ml com gelo', price:45.00, promoPrice:39.90, cost:25, category:'Combos', stock:12, image:'🧺', highlight:true, promo:true, active:true, variations:[], extras:[] },
    { id:uid(), name:'Combo Heineken', desc:'6 long necks com gelo', price:55.00, promoPrice:null, cost:30, category:'Combos', stock:10, image:'🧺', highlight:true, promo:false, active:true, variations:[], extras:[] },
    { id:uid(), name:'Combo Festa', desc:'2 vinhos + espumante + freezer box', price:120.00, promoPrice:null, cost:75, category:'Combos', stock:5, image:'🧺', highlight:false, promo:false, active:true, variations:[], extras:[] },
    { id:uid(), name:'Combo Petisco + Cerveja', desc:'Torresmo, amendoim e 4 long necks', price:49.90, promoPrice:44.90, cost:28, category:'Combos', stock:8, image:'🧺', highlight:false, promo:true, active:true, variations:[], extras:[] },
    { id:uid(), name:'Amendoim Torrado', desc:'Saco 200g', price:6.00, promoPrice:null, cost:2, category:'Petiscos', stock:25, image:'🥜', highlight:false, promo:false, active:true, variations:[], extras:[] },
    { id:uid(), name:'Batata Chips', desc:'Sacão 300g', price:7.00, promoPrice:null, cost:3, category:'Petiscos', stock:20, image:'🥔', highlight:false, promo:false, active:true, variations:[], extras:[] },
    { id:uid(), name:'Torresmo', desc:'Crocante, embalado 150g', price:12.00, promoPrice:null, cost:5, category:'Petiscos', stock:18, image:'🥓', highlight:true, promo:false, active:true, variations:[], extras:[] },
    { id:uid(), name:'Azeitonas Verde', desc:'Pote 200g', price:8.00, promoPrice:null, cost:4, category:'Petiscos', stock:12, image:'🫒', highlight:false, promo:false, active:true, variations:[], extras:[] }
  ];

const SEED_CATEGORIES = ['Refrigerantes','Sucos','Águas','Produto','Energéticos','Vinhos','Destilados','Combos','Petiscos'];

const SEED_COUPONS = [
  { id:uid(), code:'BEMVINDO10', type:'percent', value:10, min:20, active:true, uses:0, limit:0 },
  { id:uid(), code:'FRETE5', type:'fixed', value:5, min:30, active:true, uses:0, limit:0 }
];

const SEED_BAIRROS = [
  { id:uid(), name:'Centro', tax:5, km:2 },
  { id:uid(), name:'Jardim Gurilândia', tax:8, km:4 },
  { id:uid(), name:'Vila Nova', tax:12, km:7 }
];

function seed() {
  state.products = SEED_PRODUCTS.map(p => Object.assign({}, p));
  state.coupons = SEED_COUPONS.map(c => Object.assign({}, c));
  state.bairros = SEED_BAIRROS.map(b => Object.assign({}, b));
  state.categories = SEED_CATEGORIES.slice();
  state.adminLog = [];
  state.stockLog = [];
  save();
}

function mergeSeed() {
  const names = new Set(state.products.map(p => p.name.toLowerCase().trim()).filter(Boolean));
  SEED_PRODUCTS.filter(p => p.active).forEach(p => {
    if (!names.has(p.name.toLowerCase().trim())) state.products.push(Object.assign({}, p));
  });
  state.categories = [...new Set([...(state.categories || []), ...SEED_CATEGORIES])];
  const codes = new Set(state.coupons.map(c => c.code));
  SEED_COUPONS.forEach(c => { if (!codes.has(c.code)) state.coupons.push(Object.assign({}, c)); });
  const bn = new Set(state.bairros.map(b => b.name));
  SEED_BAIRROS.forEach(b => { if (!bn.has(b.name)) state.bairros.push(Object.assign({}, b)); });
  saveLocalOnly();
}

function applyTheme() {
  const c = state.config;
  document.documentElement.style.setProperty('--primary', c.colorPrimary || '#d90429');
  document.documentElement.style.setProperty('--primary-dark', c.colorPrimaryDark || '#a50320');
  document.documentElement.style.setProperty('--accent', c.themeAccent || '#ffb703');
  setTheme(currentTheme());
}

/* ==================== TEMA ==================== */
const THEME_KEY = KEY + '_theme';
function currentTheme() { try { return localStorage.getItem(THEME_KEY) || 'light'; } catch(e) { return 'light'; } }
function setTheme(mode) {
  document.documentElement.setAttribute('data-theme', mode);
  try { localStorage.setItem(THEME_KEY, mode); } catch(e) {}
  const b = $('btnTheme');
  if (b) b.textContent = mode === 'dark' ? '☀️' : '🌙';
}
function toggleTheme() { setTheme(currentTheme() === 'dark' ? 'light' : 'dark'); }

const THEMES = [
  { id: 'classic',   name: 'Clássico', primary: '#d90429', dark: '#a50320', accent: '#ffb703' },
  { id: 'tropical',  name: 'Tropical', primary: '#0e9f6e', dark: '#0b7a54', accent: '#ffd166' },
  { id: 'cerveja',   name: 'Cerveja',  primary: '#f59e0b', dark: '#d97706', accent: '#ffedd5' },
  { id: 'refresco',  name: 'Refresco', primary: '#0e7490', dark: '#155e75', accent: '#7dd3fc' },
  { id: 'forro',     name: 'Forró',    primary: '#4f46e5', dark: '#4338ca', accent: '#f5d547' },
  { id: 'elegante',  name: 'Elegante', primary: '#b91c1c', dark: '#7f1d1d', accent: '#e2b93b' }
];

function applyThemePreset(pid) {
  const t = THEMES.find(x => x.id === pid) || THEMES[0];
  state.config.themeId = t.id;
  state.config.colorPrimary = t.primary;
  state.config.colorPrimaryDark = t.dark;
  state.config.themeAccent = t.accent;
  applyTheme();
}

/* ==================== MEUS PEDIDOS ==================== */
const MY_ORDERS_KEY = KEY + '_my_orders';
function getMyOrders() { try { const l = JSON.parse(localStorage.getItem(MY_ORDERS_KEY) || '[]'); return Array.isArray(l) ? l : []; } catch(e) { return []; } }
function saveMyOrders(l) { try { localStorage.setItem(MY_ORDERS_KEY, JSON.stringify(l)); } catch(e) {} }
function pushMyOrder(record) {
  const l = getMyOrders();
  l.unshift(record);
  saveMyOrders(l.slice(0, 20));
}

/* ==================== CÓDIGOS DE ACOMPANHAMENTO ====================
   O código é mostrado uma única vez, na tela de sucesso, e o cliente pode
   fechar/limpar a tela sem querer. Guardamos o que ele recebeu e o que ele
   consultou para o botão "Acompanhar meu pedido" abrir no pedido certo. */
const TRACKS_KEY = KEY + '_my_tracks';

function getMyTracks() {
  const out = [];
  const add = c => {
    c = String(c || '').trim().toUpperCase();
    if (c && out.indexOf(c) === -1) out.push(c);
  };
  try { (JSON.parse(localStorage.getItem(TRACKS_KEY) || '[]') || []).forEach(add); } catch (e) {}
  getMyOrders().forEach(o => add(o && o.trackCode));
  return out.slice(0, 5);
}

function saveMyTrack(code) {
  const c = String(code || '').trim().toUpperCase();
  if (!c) return;
  const list = getMyTracks().filter(x => x !== c);
  list.unshift(c);
  try { localStorage.setItem(TRACKS_KEY, JSON.stringify(list.slice(0, 5))); } catch (e) {}
}

/* ==================== ENDEREÇOS ==================== */
const ADDR_KEY = KEY + '_addresses';
function getSavedAddresses() { try { return JSON.parse(localStorage.getItem(ADDR_KEY) || '[]'); } catch(e) { return []; } }
function saveAddresses(l) { try { localStorage.setItem(ADDR_KEY, JSON.stringify(l)); } catch(e) {} }

/* ==================== +18 ==================== */
const AGE_KEY = KEY + '_ageok';
function ageConfirmed() { try { return localStorage.getItem(AGE_KEY) === '1'; } catch(e) { return false; } }
function confirmAge() { try { localStorage.setItem(AGE_KEY, '1'); } catch(e) {} }
function isAlcoholic(p) {
  if (!p) return false;
  if (p.ageRestricted) return true;
  if (!state.config.requireAge) return false;
  return /álcool|alcool|cerveja|vinho|whisky|uísque|uisque|cachaça|cachaca|gin|vodka|tequila|licor|sidra|drink/i.test((p.category || '') + ' ' + (p.name || ''));
}

/* ==================== CUPONS ==================== */
const CPN_KEY = KEY + '_coupon_uses';
function couponDeviceUses(code) {
  try { const m = JSON.parse(localStorage.getItem(CPN_KEY) || '{}') || {}; return m[String(code).toUpperCase()] || 0; } catch(e) { return 0; }
}
function couponDeviceUse(code) {
  try {
    const m = JSON.parse(localStorage.getItem(CPN_KEY) || '{}') || {};
    const k = String(code).toUpperCase();
    m[k] = (m[k] || 0) + 1;
    localStorage.setItem(CPN_KEY, JSON.stringify(m));
  } catch(e) {}
}

/* ==================== PIX ==================== */
function crc16CCITT(str) {
  let crc = 0xFFFF;
  for (let i = 0; i < str.length; i++) {
    crc ^= str.charCodeAt(i) << 8;
    for (let j = 0; j < 8; j++) crc = (crc & 0x8000) ? ((crc << 1) ^ 0x1021) & 0xFFFF : (crc << 1) & 0xFFFF;
  }
  return crc.toString(16).toUpperCase().padStart(4, '0');
}
function pixFld(id, val, max) {
  const v = String(val || '').slice(0, max || 99);
  return id + String(v.length).padStart(2, '0') + v;
}
function pixPayload(amount, key, name, city, txid) {
  const merchant = '0014br.gov.bcb.pix' + pixFld('01', key, 77);
  let p = '';
  p += pixFld('00', '01');
  p += pixFld('26', merchant, 99);
  p += pixFld('52', '0000');
  p += pixFld('53', '986');
  p += pixFld('54', (Number(amount) || 0).toFixed(2), 13);
  p += pixFld('58', 'BR');
  p += pixFld('59', (name || key).toUpperCase(), 25);
  p += pixFld('60', (city || 'BRASIL').toUpperCase(), 15);
  p += pixFld('62', pixFld('05', txid || '*', 25), 99);
  p += '6304';
  return p + crc16CCITT(p);
}

/* ==================== LOG ==================== */
function logActivity(icon, text) {
  state.adminLog.unshift({ icon, text, date: new Date().toISOString() });
  if (state.adminLog.length > 100) state.adminLog = state.adminLog.slice(0, 100);
  save();
}

function logStock(icon, text) {
  state.stockLog.unshift({ icon, text, date: new Date().toISOString() });
  if (state.stockLog.length > 200) state.stockLog = state.stockLog.slice(0, 200);
  save();
}

function timeAgo(iso) {
  const diff = Math.floor((Date.now() - new Date(iso).getTime()) / 1000);
  if (diff < 60) return 'agora';
  if (diff < 3600) return Math.floor(diff/60) + ' min atrás';
  if (diff < 86400) return Math.floor(diff/3600) + ' h atrás';
  return Math.floor(diff/86400) + ' d atrás';
}

function fmtDateTime(iso) {
  const d = new Date(iso);
  return d.toLocaleDateString('pt-BR') + ' ' + d.toLocaleTimeString('pt-BR', {hour:'2-digit',minute:'2-digit'});
}

/* ==================== DETECÇÃO DE BACKEND ==================== */
const backendReady = (async function detectBackend() {
  try {
    const ctrl = typeof AbortController !== 'undefined' ? new AbortController() : null;
    const t = ctrl ? setTimeout(() => ctrl.abort(), 10000) : null;
    const r = await fetch('/api/public', { method: 'GET', signal: ctrl ? ctrl.signal : undefined });
    if (t) clearTimeout(t);
    window.__HAS_BACKEND__ = (r.status !== 404 && r.status !== 501);
  } catch (e) {
    window.__HAS_BACKEND__ = false;
  }
  return window.__HAS_BACKEND__;
})();

/* ==================== STATE GLOBAL ==================== */
Object.defineProperty(window, 'state', {
  get() { return state; },
  set(v) { state = v; },
  configurable: true
});