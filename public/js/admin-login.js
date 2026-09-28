/* ==================== LOGIN ADMIN (SEMPRE PEDE SENHA) ==================== */
let adminUnlocked = false;

function isAdminUnlocked() { return adminUnlocked === true; }
function lockAdmin() { adminUnlocked = false; }
function unlockAdmin() { adminUnlocked = true; }

function openLoginModal() {
  const pass = $('loginPass');
  const msg = $('loginMsg');
  if (!pass || !msg) return;
  pass.value = '';
  msg.textContent = '';
  msg.className = '';
  // Sem senha definida (uso offline na primeira vez), o campo cria a senha.
  const semSenha = !window.__HAS_BACKEND__ && !((window.state && state.config && state.config.adminPasswordHash) || '');
  const sub = $('loginSub');
  if (sub) sub.textContent = semSenha
    ? 'Ainda não há senha neste navegador: crie uma agora para acessar o painel.'
    : 'Digite a senha para acessar o painel administrativo.';
  $('overlayLogin').classList.add('open');
  setTimeout(() => pass.focus(), 100);
}

async function tryLogin() {
  const pass = (document.getElementById('loginPass')?.value || '').trim();
  const msg = document.getElementById('loginMsg');
  const stored = (window.state && window.state.config && window.state.config.adminPasswordHash) || '';

  if (!pass) {
    if (msg) msg.innerHTML = '<p style="color:#d90429">Digite a senha.</p>';
    return;
  }

  // Sem backend → valida localmente
  if (!window.__HAS_BACKEND__) {
    // Ainda não existe senha: a que for digitada aqui vira a senha do painel.
    if (!stored) {
      if (pass.length < 6) {
        if (msg) msg.innerHTML = '<p style="color:#d90429">Use pelo menos 6 caracteres.</p>';
        return;
      }
      state.config.adminPasswordHash = await hashPass(pass);
      saveLocalOnly();
      setToken('local');
      unlockAdmin();
      logActivity('🔐', 'Senha do painel criada');
      if (typeof closeAll === 'function') closeAll();
      if (typeof openAdminPanel === 'function') openAdminPanel();
      if (typeof renderAdmin === 'function') renderAdmin();
      if (typeof toast === 'function') toast('🔐 Senha criada — anote para os próximos acessos');
      return;
    }
    const ok = await verifyPass(pass, stored);
    if (!ok) {
      if (msg) msg.innerHTML = '<p style="color:#d90429">Senha incorreta.</p>';
      return;
    }
    setToken('local');
    unlockAdmin();
    logActivity('🔐', 'Login local');
    if (typeof closeAll === 'function') closeAll();
    if (typeof openAdminPanel === 'function') openAdminPanel();
    if (typeof renderAdmin === 'function') renderAdmin();
    if (typeof toast === 'function') toast('✅ Bem-vindo!');
    return;
  }

  // Com backend
  const res = await api('/api/login', { method: 'POST', body: { password: pass } });
  if (res && res.ok && res.token) {
    setToken(res.token);
    unlockAdmin();
    if (typeof applyServerState === 'function' && res.state) applyServerState(res.state);
    logActivity('🔐', 'Login');
    if (typeof closeAll === 'function') closeAll();
    if (typeof openAdminPanel === 'function') openAdminPanel();
    if (typeof renderAdmin === 'function') renderAdmin();
    return;
  }
  if (msg) msg.innerHTML = '<p style="color:#d90429">Senha incorreta.</p>';
}

function afterLoginSuccess() {
  closeAll();
  unlockAdmin();
  if (typeof openAdminPanel === 'function') openAdminPanel();
  if (typeof renderAdmin === 'function') renderAdmin();
  if (typeof toast === 'function') toast('✅ Bem-vindo!');
  if ('Notification' in window && Notification.permission === 'default') {
    Notification.requestPermission();
  }
}

function openAdminPanel() {
  $('viewAdmin').classList.add('active');
  $('viewMenu').classList.add('hidden');
  ['topbar', 'stickyHeader', 'cartBar', 'connStrip'].forEach(id => $(id)?.classList.add('hidden'));
  switchAdminTab('dash');
  if (window.innerWidth <= 900 && !sessionStorage.getItem('admhint')) {
    sessionStorage.setItem('admhint', '1');
    setTimeout(() => toast('👆 Toque em \u201c☰ Menu\u201d no canto superior para ver as abas do painel.'), 600);
  }
  connectEvents();
}

function closeAdminPanel() {
  lockAdmin();
  closeEvents();
  api('/api/logout', { method: 'POST' });
  setToken('');
  $('viewAdmin').classList.remove('active');
  $('viewMenu').classList.remove('hidden');
  ['topbar', 'stickyHeader', 'connStrip'].forEach(id => $(id)?.classList.remove('hidden'));
}

/* ==================== TEMPO REAL (SSE) — aviso de novo pedido ==================== */
let eventSource = null;
let lastKnownOrderMax = 0;
let audioCtx = null;

function beepNewOrder() {
  try {
    audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
    [880, 740, 880].forEach((f, i) => {
      const o = audioCtx.createOscillator();
      const g = audioCtx.createGain();
      o.type = 'sine';
      o.frequency.value = f;
      const t = audioCtx.currentTime + i * 0.2;
      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(0.35, t + 0.03);
      g.gain.exponentialRampToValueAtTime(0.0001, t + 0.18);
      o.connect(g); g.connect(audioCtx.destination);
      o.start(t); o.stop(t + 0.2);
    });
  } catch (e) {}
}

function notifyNewOrder(o) {
  beepNewOrder();
  try {
    if ('Notification' in window && Notification.permission === 'granted') {
      new Notification('🛒 Novo pedido!', { body: `#${o.id} • ${o.customer || '—'} • ${brl(o.total || 0)}` });
    }
  } catch (e) {}
}

function connectEvents() {
  if (typeof EventSource === 'undefined' || !SERVER_OK) return;
  try {
    eventSource = new EventSource('/api/events');
    eventSource.addEventListener('sync', async () => {
      if (!isAdminUnlocked()) return;
      const maxBefore = state.orders.reduce((m, o) => Math.max(m, o.id || 0), 0);
      if (await pullAdmin()) {
        const maxNow = state.orders.reduce((m, o) => Math.max(m, o.id || 0), 0);
        if (lastKnownOrderMax > 0 && maxNow > lastKnownOrderMax) {
          const fresh = state.orders.find(o => o.id === maxNow);
          notifyNewOrder(fresh || {});
        }
        if (lastKnownOrderMax === 0) lastKnownOrderMax = Math.max(maxBefore, maxNow);
        else lastKnownOrderMax = Math.max(lastKnownOrderMax, maxNow);
        renderAdmin();
      }
    });
    eventSource.onerror = () => { startPollingFallback(); };
  } catch (e) { eventSource = null; startPollingFallback(); }
}

let pollTimer = null;
function startPollingFallback() {
  if (pollTimer) return;
  pollTimer = setInterval(async () => {
    if (!isAdminUnlocked()) return;
    const maxBefore = state.orders.reduce((m, o) => Math.max(m, o.id || 0), 0);
    if (await pullAdmin()) {
      const maxNow = state.orders.reduce((m, o) => Math.max(m, o.id || 0), 0);
      if (lastKnownOrderMax > 0 && maxNow > lastKnownOrderMax) {
        const fresh = state.orders.find(o => o.id === maxNow);
        notifyNewOrder(fresh || {});
      }
      if (lastKnownOrderMax === 0) lastKnownOrderMax = Math.max(maxBefore, maxNow);
      else lastKnownOrderMax = Math.max(lastKnownOrderMax, maxNow);
      renderAdmin();
    }
  }, 10000);
}
function stopPollingFallback() {
  if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
}

function closeEvents() {
  if (eventSource) { try { eventSource.close(); } catch (e) {} eventSource = null; }
  stopPollingFallback();
}

document.addEventListener('DOMContentLoaded', () => {
  const btnAdmin = $('btnAdmin');
  if (btnAdmin) {
    btnAdmin.onclick = () => {
      const isPanelOpen = $('viewAdmin').classList.contains('active');
      if (isPanelOpen) { closeAdminPanel(); return; }
      if (!isAdminUnlocked()) { openLoginModal(); return; }
      openAdminPanel();
    };
  }

  const btnLogout = $('btnLogout');
  if (btnLogout) btnLogout.onclick = () => {
    showConfirm('Sair do painel?', () => {
      logActivity('🔒', 'Admin saiu do painel');
      lockAdmin();
      closeAdminPanel();
      toast('👋 Sessão encerrada');
    });
  };

  const btnDoLogin = $('btnDoLogin');
  if (btnDoLogin) btnDoLogin.onclick = tryLogin;

  const loginPass = $('loginPass');
  if (loginPass) loginPass.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); tryLogin(); }
  });

  const btnBackToMenu = $('btnBackToMenu');
  if (btnBackToMenu) btnBackToMenu.onclick = () => closeAdminPanel();

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && $('viewAdmin').classList.contains('active')) {
      closeAdminPanel();
    }
  });
});

/* ==================== NAVEGAÇÃO ENTRE ABAS ==================== */
const PAGE_TITLES = {
  dash: 'Dashboard',
  prod: 'Produto',
  cat: 'Categorias',
  ped: 'Pedidos',
  rel: 'Relatórios',
  cup: 'Cupons',
  bair: 'Frete e Regiões',
  estoque: 'Controle de Estoque',
  log: 'Atividades',
  cfg: 'Configurações',
  sec: 'Segurança'
};

function switchAdminTab(tab) {
  document.querySelectorAll('.sb-item').forEach(x => x.classList.toggle('active', x.dataset.tab === tab));
  document.querySelectorAll('#viewAdmin .admin-section').forEach(x => x.classList.remove('active'));
  const target = $('tab-' + tab);
  if (target) target.classList.add('active');
  const titleEl = $('adminPageTitle');
  if (titleEl) titleEl.textContent = PAGE_TITLES[tab] || 'Painel';

  // Fecha sidebar no mobile após escolher
  if (window.innerWidth <= 900) {
    $('admin-sidebar')?.classList.remove('open');
  }

  // Renderiza conteúdo da aba
  if (tab === 'dash') renderDashboard();
  if (tab === 'prod') renderAdminProducts();
  if (tab === 'cat') renderCategories();
  if (tab === 'ped') renderAdminOrders();
  if (tab === 'rel') renderReport();
  if (tab === 'cup') renderCoupons();
  if (tab === 'bair') renderBairros();
  if (tab === 'estoque') renderEstoque();
  if (tab === 'log') renderAdminLog();
  if (tab === 'cfg') renderConfig();
  if (tab === 'sec') renderSecPage();
}

document.addEventListener('DOMContentLoaded', () => {
  document.querySelectorAll('.sb-item').forEach(b => {
    b.onclick = () => switchAdminTab(b.dataset.tab);
  });
  const toggle = $('btnAdminToggle');
  if (toggle) toggle.onclick = () => $('admin-sidebar')?.classList.toggle('open');
});