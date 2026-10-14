/* ==================== LOGIN ADMIN (SEMPRE PEDE SENHA) ==================== */
let adminUnlocked = false;
let allowLeaveAdmin = false; // só o botão "Sair" libera a saída do painel

function isAdminUnlocked() { return adminUnlocked === true; }
function lockAdmin() { adminUnlocked = false; }
function unlockAdmin() { adminUnlocked = true; }

function openLoginModal() {
  const pass = $('loginPass');
  const msg = $('loginMsg');
  if (!pass || !msg) return;
  pass.value = '';
  const mail = $('loginEmail');
  if (mail) {
    // mantém o e-mail entre aberturas (digitar de novo é chato)
    try { if (!mail.value) mail.value = localStorage.getItem(KEY + '_admin_email') || ''; } catch (e) {}
  }
  msg.textContent = '';
  msg.className = '';
  // Sem senha definida (uso offline na primeira vez), o campo cria a senha.
  const semSenha = !window.__HAS_BACKEND__ && !((window.state && state.config && state.config.adminPasswordHash) || '');
  const sub = $('loginSub');
  const loja = (typeof getCurrentTenant === 'function' && getCurrentTenant()) || '';
  if (sub) sub.textContent = semSenha
    ? 'Ainda não há senha neste navegador: crie uma agora para acessar o painel.'
    : (window.__HAS_BACKEND__
        ? 'Informe seu e-mail e senha para acessar o painel' + (loja ? ' de ' + loja + '.' : '.')
        : 'Digite a senha para acessar o painel administrativo.');
  $('overlayLogin').classList.add('open');
  setTimeout(() => (mail || pass).focus(), 100);
}

/* Nome da loja no topo do painel + aviso quando a sessão é de impersonação */
async function paintTenantBadge() {
  const badge = $('adminTenantBadge');
  const banner = $('impBanner');
  const impName = $('impTenantName');
  try {
    const res = await api('/api/auth/me', { method: 'GET' });
    if (!res || !res.ok) return;
    const nome = (res.tenant && res.tenant.name) || '';
    const plano = (res.tenant && res.tenant.plan) || '';
    if (badge) {
      badge.textContent = nome + (plano ? ' · ' + plano : '');
      badge.style.display = nome ? '' : 'none';
    }
    if (banner && impName) {
      const imp = !!res.impersonated || (typeof isImpersonating === 'function' && isImpersonating());
      banner.style.display = imp ? '' : 'none';
      if (imp) impName.textContent = nome;
    }
  } catch (e) { /* badge é enfeite: nunca pode travar o painel */ }
}

async function tryLogin() {
  const pass = (document.getElementById('loginPass')?.value || '').trim();
  const mailInput = document.getElementById('loginEmail');
  const mail = (mailInput?.value || '').trim().toLowerCase();
  const msg = document.getElementById('loginMsg');
  const stored = (window.state && window.state.config && state.config.adminPasswordHash) || '';

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
      if (typeof toast === 'function') toast('Senha criada — anote para os próximos acessos');
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
    if (typeof toast === 'function') toast('Bem-vindo!');
    return;
  }

  // Com backend: multi-tenant (o tenant vem do host/subdomínio).
  // E-mail é o normal, mas loja com um único admin aceita só a senha
  // (é como o painel antigo funcionava) — o servidor decide.
  if (mail) { try { localStorage.setItem(KEY + '_admin_email', mail); } catch (e) {} }

  const res = await api('/api/login', { method: 'POST', body: { email: mail, password: pass } });
  if (res && res.ok && res.token) {
    setToken(res.token);
    unlockAdmin();
    if (typeof applyServerState === 'function' && res.state) applyServerState(res.state);
    logActivity('🔐', 'Login');
    if (typeof closeAll === 'function') closeAll();
    if (typeof openAdminPanel === 'function') openAdminPanel();
    if (typeof renderAdmin === 'function') renderAdmin();
    paintTenantBadge();
    if (res.impersonated && typeof toast === 'function') {
      toast('Acesso como administrador da loja ' + ((res.tenant && res.tenant.name) || ''), 6000);
    }
    return;
  }
  /* Sem `res` a rede caiu — dizer "senha incorreta" aí só confunde. */
  if (msg) msg.innerHTML = res && res.error
    ? `<p style="color:#d90429">${esc(res.error)}</p>`
    : '<p style="color:#d90429">Não consegui conectar ao servidor. Verifique a conexão e tente de novo.</p>';
}

function openAdminPanel() {
  allowLeaveAdmin = false;
  $('viewAdmin').classList.add('active');
  $('viewMenu').classList.add('hidden');
  ['topbar', 'stickyHeader', 'cartBar'].forEach(id => $(id)?.classList.add('hidden'));
  switchAdminTab('dash');
  if (window.innerWidth <= 900 && !sessionStorage.getItem('admhint')) {
    sessionStorage.setItem('admhint', '1');
    setTimeout(() => toast('👆 Toque em \u201c☰ Menu\u201d no canto superior para ver as abas do painel.'), 600);
  }
  connectEvents();
  updateNotifyBtn();
}

function closeAdminPanel(force) {
  // Enquanto o painel estiver aberto, só o botão "Sair" (allowLeaveAdmin/force)
  // pode fechá-lo. Esc, botão voltar do navegador e o botão do topo são ignorados.
  if (!force && !allowLeaveAdmin) return;
  allowLeaveAdmin = false;
  lockAdmin();
  closeEvents();
  api('/api/logout', { method: 'POST' });
  setToken('');
  $('viewAdmin').classList.remove('active');
  $('viewMenu').classList.remove('hidden');
  /* cartBar precisa voltar junto: senão a barra do carrinho fica sem barra para sempre */
  ['topbar', 'stickyHeader', 'cartBar'].forEach(id => $(id)?.classList.remove('hidden'));
}

/* ==================== TEMPO REAL (SSE) — aviso de novo pedido ==================== */
let eventSource = null;
let lastKnownOrderMax = 0;
let orderMaxSeeded = false;
let audioCtx = null;

/* Semeia o contador com o estado que já está carregado (o login traz o state).
   Sem isso o primeiro pedido da loja nunca era "novo": a condição era
   `maxNow > 0`, e com a loja vazia (contador 0) o #1 passava em silêncio. */
function seedOrderMax() {
  lastKnownOrderMax = (state.orders || []).reduce((m, o) => Math.max(m, Number(o.id) || 0), 0);
  orderMaxSeeded = true;
}

/* Compara o maior id com o último visto e avisa só quando ele sobe.
   Queda de número (servidor renumera #1, #2…) só reseta o contador —
   nunca vira "novo pedido". */
function detectNewOrder(maxNow) {
  const prev = orderMaxSeeded ? lastKnownOrderMax : -1;
  orderMaxSeeded = true;
  if (prev < 0) { lastKnownOrderMax = maxNow; return; }
  if (maxNow > prev) {
    const fresh = (state.orders || []).find(o => Number(o.id) === Number(maxNow));
    notifyNewOrder(fresh || {});
    lastKnownOrderMax = maxNow;
  } else if (maxNow < prev) {
    lastKnownOrderMax = maxNow;
  }
}

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

/* Cópia do pedido para o WhatsApp do lojista (texto próprio do painel:
   o checkout manda o resumo pro cliente, aqui é o pedido completo). */
function orderCopyMessage(o) {
  let m = `*NOVO PEDIDO #${o.id}*\n\n`;
  m += `*Cliente:* ${o.customer || '—'}\n`;
  if (o.phone) m += `*Telefone:* ${o.phone}\n`;
  m += `*Tipo:* ${o.type || 'Entrega'}\n`;
  if (o.type !== 'Retirada' && o.address) m += `*Endereço:* ${o.address}\n`;
  if (o.bairro) m += `*Bairro:* ${o.bairro}\n`;
  if (o.km) m += `*Distância:* ${o.km} km\n`;
  m += `*Pagamento:* ${o.payment || '—'}\n`;
  if (o.change) m += `*Troco para:* ${o.change}\n`;
  m += `\n*ITENS:*\n`;
  (o.items || []).forEach(i => {
    m += `• ${i.qty}x ${i.name}${i.variation ? ' (' + i.variation + ')' : ''}`;
    if (i.extras && i.extras.length) m += ` + ${i.extras.join(', ')}`;
    m += ` — ${brl(i.total)}\n`;
    if (i.obs) m += `   _${i.obs}_\n`;
  });
  m += `\n*Subtotal:* ${brl(o.subtotal || 0)}`;
  if (o.discount) m += `\n*Desconto${o.coupon ? ' (' + o.coupon + ')' : ''}:* − ${brl(o.discount)}`;
  if (o.delivery) m += `\n*Frete:* ${brl(o.delivery)}`;
  m += `\n*TOTAL:* ${brl(o.total || 0)}`;
  if (o.notes) m += `\n\n*Obs geral:* ${o.notes}`;
  return m;
}

/* wa.me exige pop-up: aqui não existe clique do lojista, então o navegador
   pode barrar. Não é motivo para perder o pedido — avisa e segue. */
function sendOrderCopyToWhatsapp(o) {
  const num = String((state.config && state.config.whatsapp) || '').replace(/\D/g, '');
  if (!o || !o.id || !num) return;
  const url = `https://wa.me/${num}?text=${encodeURIComponent(orderCopyMessage(o))}`;
  const w = window.open(url, '_blank');
  if (!w) toast('Pop-up bloqueado: libere pop-ups para este site para receber a cópia no WhatsApp.', 7000);
}

function notifyNewOrder(o) {
  const cfg = state.config || {};
  if (cfg.soundAlert !== false) beepNewOrder();
  const linha = (o && o.id)
    ? `Novo pedido #${o.id} — ${o.customer || '—'} — ${brl(o.total || 0)}`
    : 'Novo pedido!';
  /* Toast só existe dentro do painel desbloqueado (o chamador já valida).
     Nunca é mostrado para quem está só vendo o cardápio. */
  if (typeof toast === 'function') toast(linha, 8000);
  try {
    if ('Notification' in window && Notification.permission === 'granted') {
      new Notification('Novo pedido!', {
        body: (o && o.id) ? `#${o.id} • ${o.customer || '—'} • ${brl(o.total || 0)}` : 'Um novo pedido entrou no painel.',
        tag: 'novo-pedido'
      });
    }
  } catch (e) {}
  if (cfg.notifyWpp && o && o.id) sendOrderCopyToWhatsapp(o);
}

/* ==================== PERMISSÃO DE NOTIFICAÇÃO (só por clique) ==================== */
function notifyPermState() {
  if (typeof Notification === 'undefined') return 'unsupported';
  return Notification.permission;
}

function updateNotifyBtn() {
  const st = notifyPermState();
  let txt = '', h = '';
  if (st === 'unsupported') {
    txt = '🔕 Notificações não suportadas neste navegador';
    h = 'Som e aviso no painel continuam funcionando.';
  } else if (st === 'granted') {
    txt = 'Notificações ativadas';
    h = 'Você receberá um aviso do sistema a cada pedido novo.';
  } else if (st === 'denied') {
    txt = '🔕 Notificação bloqueada pelo navegador';
    h = 'Libere o site nas permissões do navegador (ícone ao lado da barra de endereço).';
  } else {
    txt = 'Ativar notificações do sistema';
    h = 'Som e aviso no painel já funcionam. Esta opção mostra o aviso também com outra aba em foco.';
  }
  /* O mesmo controle aparece em Segurança e em Configurações › Notificações. */
  [['btnNotifyPerm', 'notifyHint'], ['btnNotifyPerm2', 'notifyHint2']].forEach(([btnId, hintId]) => {
    const btn = $(btnId), hint = $(hintId);
    if (btn) { btn.textContent = txt; btn.disabled = (st === 'unsupported' || st === 'granted'); }
    if (hint) hint.textContent = h;
  });
}

/* Nunca é chamada sozinha: precisa de um clique (regra do navegador) e
   não faz nada se o painel não estiver desbloqueado. */
async function requestNotifyPerm() {
  if (typeof Notification === 'undefined') { toast('Este navegador não tem notificações'); return; }
  try {
    const p = await Notification.requestPermission();
    if (p === 'granted')     toast('Notificações ativadas');    else if (p === 'denied') toast('🔕 Bloqueada — libere nas permissões do navegador');
    else toast('Ativação cancelada');
  } catch (e) {
    toast('Não foi possível ativar as notificações');
  }
  updateNotifyBtn();
}

async function connectEvents() {
  seedOrderMax();
  if (typeof EventSource === 'undefined' || !SERVER_OK) return;
  try {
    const result = await api('/api/events/ticket', { method: 'POST' });
    if (!result || !result.ok || !result.ticket) {
      startPollingFallback();
      return;
    }
    // EventSource não aceita headers; usa ticket de uso único em vez do JWT na URL.
    const query = typeof tenantQuery === 'function' ? tenantQuery() : '';
    eventSource = new EventSource('/api/events' + query + (query ? '&' : '?') + 'ticket=' + encodeURIComponent(result.ticket));
    eventSource.addEventListener('sync', async () => {
      if (!isAdminUnlocked()) return;
      if (await pullAdmin()) {
        detectNewOrder((state.orders || []).reduce((m, o) => Math.max(m, Number(o.id) || 0), 0));
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
    if (await pullAdmin()) {
      detectNewOrder((state.orders || []).reduce((m, o) => Math.max(m, Number(o.id) || 0), 0));
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
      if (isPanelOpen) { toast('Para sair, use o botão Sair'); return; }
      if (!isAdminUnlocked()) { openLoginModal(); return; }
      openAdminPanel();
    };
  }

  const btnLogout = $('btnLogout');
  if (btnLogout) btnLogout.onclick = () => {
    showConfirm('Sair do painel?', () => {
      allowLeaveAdmin = true;
      logActivity('🔒', 'Admin saiu do painel');
      closeAdminPanel(true);
      toast('👋 Sessão encerrada');
    });
  };

  const btnDoLogin = $('btnDoLogin');
  if (btnDoLogin) btnDoLogin.onclick = tryLogin;

  const loginPass = $('loginPass');
  if (loginPass) loginPass.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); tryLogin(); }
  });

  const btnNotifyPerm = $('btnNotifyPerm');
  if (btnNotifyPerm) btnNotifyPerm.onclick = requestNotifyPerm;
  const btnNotifyPerm2 = $('btnNotifyPerm2');
  if (btnNotifyPerm2) btnNotifyPerm2.onclick = requestNotifyPerm;

  /* Ouvir o bipe é o que destrava o AudioContext: sem um clique anterior o
     navegador entrega o contexto suspenso e o som não sai. */
  const btnTestSound = $('btnTestSound');
  if (btnTestSound) btnTestSound.onclick = () => {
    beepNewOrder();
    toast('🔊 Este é o som do alerta de novo pedido');
  };

  const btnGoNotifyCfg = $('btnGoNotifyCfg');
  if (btnGoNotifyCfg) btnGoNotifyCfg.onclick = () => switchAdminTab('cfg');

  // Sai da impersonação: limpa a sessão desta aba e volta ao cardápio
  const btnImpExit = $('impExit');
  if (btnImpExit) btnImpExit.onclick = () => {
    if (typeof stopImpersonation === 'function') stopImpersonation();
    api('/api/logout', { method: 'POST' });
    setToken('');
    location.href = location.pathname;
  };
  updateNotifyBtn();

  /* Escape fecha o diálogo aberto (comprado pelo app.js). Só sai do painel
     quando não há overlay — senão quem estava vendo um pedido era expulso
     do painel ao fechar a janela. Capture=true garante que esta checagem
     rode antes do closeAll() do app.js. */
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape' || !$('viewAdmin').classList.contains('active')) return;
    if (document.querySelector('.overlay.open')) return;
    closeAdminPanel();
  }, true);
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