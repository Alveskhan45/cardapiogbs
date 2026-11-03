/* CardapioDigital - landing page (extraido de pages/landing.html) */
/* Redireciona quem chega com ?tenant= direto para o cardapio */
/* Se vier com ?tenant=..., redireciona para o cardápio da loja */
if (new URLSearchParams(location.search).get('tenant')) {
  location.replace('/cardapio' + location.search);
}

var PLATFORM_WHATSAPP = '';

var FEAT_LABELS = {
  coupons: 'Cupons de desconto', reports: 'Relatórios', loyalty: 'Fidelidade',
  multi_users: 'Equipe', api_access: 'Acesso à API', priority_support: 'Suporte prioritário'
};

function toast(msg) {
  var t = document.getElementById('toast');
  t.textContent = msg; t.classList.add('on');
  clearTimeout(toast._t);
  toast._t = setTimeout(function () { t.classList.remove('on'); }, 2800);
}
function brl(v) { return 'R$ ' + (Number(v) || 0).toFixed(2).replace('.', ','); }
function limTxt(v) { v = Number(v); return (v === 0 || v === -1) ? 'ilimitado' : v; }

var _leadSent = {};
function sendLead(key, payload) {
  if (_leadSent[key]) return;
  _leadSent[key] = true;
  fetch('/api/public/leads', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload || {}), keepalive: true
  }).catch(function () {});
}

function waNumber() { return String(PLATFORM_WHATSAPP || '').replace(/\D/g, ''); }

var PLANS_CACHE = [];
var FALLBACK_PLANS = [
  { id: 'free', name: 'Grátis', priceMonthly: 0, limits: { products: 20, orders_month: 200, users: 1 }, features: { coupons: true } },
  { id: 'starter', name: 'Start', priceMonthly: 99.9, limits: { products: 100, orders_month: 1000, users: 2 }, features: { coupons: true, reports: true } },
  { id: 'pro', name: 'Pro', priceMonthly: 299.9, limits: { products: 500, orders_month: 10000, users: 10 }, features: { coupons: true, reports: true, multi_users: true } }
];

function planMessage(p) {
  return 'Olá! Quero assinar o plano ' + p.name + ' (' + (Number(p.priceMonthly) === 0 ? 'Grátis' : brl(p.priceMonthly) + '/mês') + ')';
}

var CONTRACT_KEY = 'saas_contract_token';
var STATE = { plan: null, contract: null, pix: null };

function findPlan(id) {
  var list = PLANS_CACHE.length ? PLANS_CACHE : FALLBACK_PLANS;
  for (var i = 0; i < list.length; i++) if (list[i].id === id) return list[i];
  return null;
}
function saveToken(t) { try { localStorage.setItem(CONTRACT_KEY, t); } catch (e) {} }
function readToken() { try { return localStorage.getItem(CONTRACT_KEY) || ''; } catch (e) { return ''; } }

function openSignup(planId) {
  var p = findPlan(planId);
  if (!p) { toast('Plano indisponível.'); return; }
  STATE.plan = p;
  document.getElementById('suTitle').textContent = 'Contratar ' + p.name;
  document.getElementById('suSub').textContent = Number(p.priceMonthly) === 0 ? 'Plano gratuito por 7 dias.' : brl(p.priceMonthly) + '/mês. Crie sua conta agora.';
  document.getElementById('suErr').textContent = '';
  document.getElementById('signupModal').classList.add('show');
}

async function submitSignup() {
  var err = document.getElementById('suErr');
  err.textContent = '';
  var store = document.getElementById('suStore').value.trim();
  var owner = document.getElementById('suOwner').value.trim();
  var phone = document.getElementById('suPhone').value.trim();
  var email = document.getElementById('suEmail').value.trim();
  var pass = document.getElementById('suPass').value;
  if (store.length < 2) { err.textContent = 'Informe o nome da loja.'; return; }
  if (!email) { err.textContent = 'Informe seu e-mail.'; return; }
  if (pass.length < 8) { err.textContent = 'A senha precisa de pelo menos 8 caracteres.'; return; }
  var btn = document.getElementById('suSubmit');
  btn.disabled = true; btn.textContent = 'Criando…';
  try {
    var r = await fetch('/api/public/signup', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ plan: STATE.plan.id, storeName: store, ownerName: owner, phone: phone, email: email, password: pass })
    });
    var d = await r.json();
    if (!d.ok) { err.textContent = d.error || 'Não foi possível criar a conta.'; return; }
    saveToken(d.signupToken);
    document.getElementById('signupModal').classList.remove('show');
    ['suStore','suOwner','suPhone','suEmail','suPass'].forEach(function(id){document.getElementById(id).value='';});
    toast('Conta criada!');
  } catch (e) { err.textContent = 'Falha de conexão.'; }
  finally { btn.disabled = false; btn.textContent = 'Criar conta'; }
}

function planCard(p) {
  var price = Number(p.priceMonthly || 0);
  var lim = p.limits || {}, feat = p.features || {};
  var featsOn = Object.keys(FEAT_LABELS).filter(function(k){return feat[k];});
  var benefits = [
    limTxt(lim.products) + ' produtos',
    limTxt(lim.orders_month) + ' pedidos/mês',
    limTxt(lim.users) + ' usuário(s)'
  ].concat(featsOn.slice(0,4).map(function(k){return FEAT_LABELS[k];}));
  var li = benefits.map(function(b){return '<li>'+b+'</li>';}).join('');
  var pop = p.id === 'pro';
  return '<div class="plan'+(pop?' pop':'')+'">'
    + (pop?'<span class="flag">Recomendado</span>':'')
    + '<h3>'+p.name+'</h3>'
    + '<div class="price">'+(price===0?'Grátis':brl(price))+'</div>'
    + '<div class="per">'+(price===0?'7 dias grátis':'/mês')+'</div>'
    + '<ul>'+li+'</ul>'
    + '<button class="btn '+(pop?'pri':'outline')+' block" data-plan-cta="'+p.id+'">'
    + (price===0?'Começar grátis':'Contratar')+'</button></div>';
}

function openPlanModal(id) {
  var p = findPlan(id);
  if (!p) return;
  sendLead('plan:'+p.id,{plan:p.id,source:'plan'});
  var price = Number(p.priceMonthly||0);
  document.getElementById('pmTitle').textContent = p.name;
  document.getElementById('pmSub').textContent = price===0?'Plano gratuito por 7 dias, sem cartão.':brl(price)+'/mês, sem fidelidade.';
  document.getElementById('pmMsg').textContent = planMessage(p);
  document.getElementById('planModal').classList.add('show');
}

async function loadPlans() {
  var grid = document.getElementById('planGrid');
  try {
    var r = await fetch('/api/public/plans');
    var d = await r.json();
    if (!d.ok || !d.plans || !d.plans.length) throw new Error();
    PLANS_CACHE = d.plans;
    if (d.support_whatsapp) PLATFORM_WHATSAPP = d.support_whatsapp;
  } catch(e) {
    PLANS_CACHE = FALLBACK_PLANS;
  }
  grid.innerHTML = PLANS_CACHE.map(planCard).join('');
  grid.querySelectorAll('[data-plan-cta]').forEach(function(btn){
    btn.onclick = function(){ openSignup(btn.getAttribute('data-plan-cta')); };
  });
}

function cleanSlug(v) {
  var s = String(v||'').trim().toLowerCase();
  return /^[a-z0-9][a-z0-9-]{0,98}[a-z0-9]$/.test(s)?s:'';
}
async function clientLoginGo() {
  var typed = String(document.getElementById('loginSlug').value||'').trim().toLowerCase();
  var err = document.getElementById('loginErr');
  err.textContent = '';
  if (!typed) { err.textContent = 'Digite o nome da loja.'; return; }
  var btn = document.getElementById('loginGo');
  btn.disabled = true; btn.textContent = 'Buscando…';
  try {
    var r = await fetch('/api/public/tenant/'+encodeURIComponent(typed));
    var d = await r.json();
    if (!d.ok||!d.tenant) { err.textContent = 'Loja não encontrada.'; return; }
    location.href = '/?tenant='+encodeURIComponent(d.tenant.subdomain);
  } catch(e) { err.textContent = 'Erro de conexão.'; }
  finally { btn.disabled = false; btn.textContent = 'Entrar'; }
}

function openModal(id) {
  var m = document.getElementById(id);
  if (m) m.classList.add('show');
}
function closeModal(id) {
  var m = document.getElementById(id);
  if (m) m.classList.remove('show');
}

document.addEventListener('click', function(e) {
  var t = e.target;

  if (t.id === 'btnClientLogin' || (t.closest && t.closest('#btnClientLogin'))) {
    e.preventDefault();
    document.getElementById('loginErr').textContent = '';
    document.getElementById('loginSlug').value = '';
    openModal('loginModal');
    setTimeout(function(){ document.getElementById('loginSlug').focus(); }, 50);
  }

  if (t.id === 'loginClose' || (t.closest && t.closest('#loginClose'))) closeModal('loginModal');
  if (t.id === 'loginGo' || (t.closest && t.closest('#loginGo'))) clientLoginGo();
  if (t.id === 'pmClose' || (t.closest && t.closest('#pmClose'))) closeModal('planModal');
  if (t.id === 'suClose' || (t.closest && t.closest('#suClose'))) closeModal('signupModal');
  if (t.id === 'stClose' || (t.closest && t.closest('#stClose'))) closeModal('statusModal');

  if (t.id === 'btnWaHero' || (t.closest && t.closest('#btnWaHero'))) {
    e.preventDefault();
    var n = waNumber();
    if (n) window.open('https://wa.me/' + n + '?text=' + encodeURIComponent('Olá! Quero saber mais sobre o CardapioDigital'), '_blank');
    else openModal('planModal');
  }

  var cta = t.closest ? t.closest('[data-plan-cta]') : null;
  if (cta) openSignup(cta.getAttribute('data-plan-cta'));
});

document.addEventListener('keydown', function(e) {
  if (e.key === 'Enter' && document.activeElement && document.activeElement.id === 'loginSlug') {
    clientLoginGo();
  }
  if (e.key === 'Enter' && document.activeElement && document.activeElement.id === 'suForm') {
    e.preventDefault(); submitSignup();
  }
});

loadPlans();
