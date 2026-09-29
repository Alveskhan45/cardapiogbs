/* ==================== INICIALIZAÇÃO v6 ==================== */

/* --- Indicador de conexão com o servidor --- */
function setConnUI(status) {
  const pill = $('serverState');
  if (!pill) return;
  pill.className = status === 'on' ? 'on' : (status === 'off' ? 'off' : 'syncing');
  pill.textContent = status === 'on' ? 'online' : (status === 'off' ? 'offline' : 'sincronizando');
}

// Global confirm modal. onCancel cobre cancelar, Escape e closeAll() — sem ele
// quem espera a Promise fica pendurado para sempre.
let _confirmCancel = null;
function showConfirm(msg, onOk, title, onCancel) {
  const t = title || 'Confirmar';
  const overlay = $('overlayConfirm');
  if (!overlay) { if (onOk) onOk(); return; }
  const titleEl = $('confirmTitle');
  const msgEl = $('confirmMsg');
  const okBtn = $('confirmOk');
  const cancelBtn = $('confirmCancel');
  if (!overlay || !titleEl || !msgEl || !okBtn || !cancelBtn) { if (onOk) onOk(); return; }
  const dismiss = (fn) => {
    overlay.classList.remove('open');
    _confirmCancel = null;
    if (fn) fn();
  };
  titleEl.textContent = t;
  msgEl.textContent = msg;
  okBtn.onclick = () => dismiss(onOk);
  cancelBtn.onclick = () => dismiss(onCancel);
  _confirmCancel = () => dismiss(onCancel);
  overlay.classList.add('open');
}

function renderContactInfo() {
  const c = state.config;
  const phone = c.phone || c.whatsapp || '';
  const handle = c.instagram || (c.storeName || 'loja').toLowerCase().replace(/\s+/g,'');
  const top = $('topbarContact');
  if (top) top.innerHTML = `📞 ${esc(phone)} <span style="margin:0 8px">|</span> @${esc(handle)}`;
  const foot = $('ftPhone');
  if (foot) foot.textContent = 'Telefone: ' + phone;

  // Banner e nome são Alternatives: com banner, o nome some do topo.
  const banner = $('heroBanner');
  const name = $('heroName');
  const bannerSrc = String(c.storeBanner || '').trim();
  if (banner) {
    if (bannerSrc) { banner.src = bannerSrc; banner.hidden = false; }
    else { banner.removeAttribute('src'); banner.hidden = true; }
  }
  if (name) {
    const hasName = !!String(c.storeName || '').trim();
    name.textContent = hasName ? '🥤 ' + c.storeName : '';
    // Banner substitui o nome; sem nome e sem banner, nada de "🥤 Produto" solto.
    name.hidden = !hasName || !!bannerSrc;
  }
  const slogan = $('heroSlogan');
  if (slogan) {
    const sl = String(c.slogan || '').trim();
    slogan.textContent = sl;
    slogan.hidden = !sl;
  }

  // Legenda só aparece se houver valor: campo em branco = nada na tela.
  const hero = $('heroMin');
  const hasMin = Number(c.minOrder) > 0;
  if (hero) {
    hero.textContent = hasMin ? `Pedido mínimo: ${brl(c.minOrder)}` : '';
    hero.hidden = !hasMin;
  }
  const heroTime = $('heroTime');
  const hasTime = !!String(c.deliveryTime || '').trim();
  if (heroTime) {
    heroTime.textContent = hasTime ? `Entrega: ${c.deliveryTime}` : '';
    heroTime.hidden = !hasTime;
  }
  const heroMeta = $('heroMeta');
  if (heroMeta) {
    heroMeta.hidden = !hasMin && !hasTime;
  }

  const ftName = $('ftName');
  if (ftName) ftName.textContent = `🥤 ${c.storeName || 'Produto'}`;
  const ftAddress = $('ftAddress');
  if (ftAddress) ftAddress.textContent = c.address || '';
  const ftMap = $('ftMapLink');
  if (ftMap) {
    const url = mapsUrl(mapsTargetFromConfig(c));
    ftMap.hidden = !url;
    if (url) ftMap.href = url; else ftMap.removeAttribute('href');
  }
}

/* ==================== ACOMPANHAR PEDIDO ==================== */
const TRACK_STEPS = ['pendente', 'preparando', 'entregando', 'entregue'];
const TRACK_LABELS = { pendente: 'Pedido recebido', preparando: 'Em preparo', entregando: 'Saiu para entrega', entregue: 'Entregue' };
/* Status que não mudam mais: não faz sentido seguir consultando o servidor. */
const TRACK_DONE = ['entregue', 'cancelado'];
let _trackTimer = null;

function trackStatusLabel(o) {
  if (!o) return '—';
  if (o.status === 'cancelado') return 'Cancelado';
  return TRACK_LABELS[o.status] || String(o.status);
}

function isTrackDone(o) {
  return !!(o && TRACK_DONE.indexOf(o.status) !== -1);
}

/* Hora de cada etapa, vinda do statusHistory gravado pelo painel/servidor.
   Pedido antigo sem histórico: cai para createdAt (início) e statusUpdatedAt
   (etapa atual), sem inventar hora para o que não foi registrado. */
function trackTimes(o) {
  const map = {};
  (Array.isArray(o.statusHistory) ? o.statusHistory : []).forEach(e => {
    if (e && e.status && e.at) map[e.status] = e.at;
  });
  if (!map.pendente && o.createdAt) map.pendente = o.createdAt;
  if (o.status && !map[o.status]) map[o.status] = o.statusUpdatedAt || o.createdAt;
  return map;
}

function fmtTrackTime(iso) {
  const d = new Date(iso);
  if (isNaN(d.getTime())) return '';
  const sameDay = d.toDateString() === new Date().toDateString();
  const hm = d.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
  return sameDay ? hm : d.toLocaleDateString('pt-BR') + ' ' + hm;
}

function stopTracking() {
  if (_trackTimer) { clearInterval(_trackTimer); _trackTimer = null; }
}

function renderTrackBody(o, auto) {
  const body = $('trackBody');
  if (!body) return;
  const canceled = o.status === 'cancelado';
  const done = isTrackDone(o);
  /* `auto` só vale se o pedido ainda estiver em andamento. */
  const live = !!auto && !done;
  const idx = TRACK_STEPS.indexOf(o.status);
  const times = trackTimes(o);
  const steps = TRACK_STEPS.map((s, i) => {
    let cls = '', dot = i + 1;
    if (canceled) { cls = 'canceled'; dot = '✕'; }
    else if (idx >= 0) {
      /* Pedido concluído: todas as etapas viram ✓. Em andamento, a etapa
         atual mostra o número para indicar onde ele parou. */
      if (i < idx || (done && i === idx)) { cls = 'done'; dot = '✓'; }
      else if (i === idx) { cls = 'active'; }
    }
    const when = times[s] ? fmtTrackTime(times[s]) : '';
    return `<div class="track-step ${cls}">
      <div class="track-dot">${dot}</div>
      <div class="track-label">
        <b>${TRACK_LABELS[s]}</b>
        ${when ? `<small class="track-when">${when}</small>` : ''}
      </div>
    </div>`;
  }).join('');

  const waitMsg = done
    ? '✅ Pedido entregue'
    : (live ? '<div class="spinner"></div> Atualiza automaticamente a cada 15s' : '');

  body.innerHTML = `
    <div class="track-hero">
      <div class="succ-ico">${canceled ? '🚫' : (idx >= TRACK_STEPS.length - 1 ? '🎉' : '📦')}</div>
      <h2>Pedido #${esc(o.id)}</h2>
      <p><b style="text-transform:capitalize">${esc(trackStatusLabel(o))}</b> • Total ${brl(o.total)}</p>
    </div>
    <div class="track-steps">${steps}</div>
    ${waitMsg ? `<div class="track-wait">${waitMsg}</div>` : ''}
    <div style="display:flex;gap:8px;justify-content:center;margin-top:10px;flex-wrap:wrap">
      <button class="btn ghost sm" id="btnTrackRefresh">🔄 Atualizar agora</button>
      <button class="btn ghost sm" id="btnTrackOther">🔍 Outro código</button>
    </div>
    <p class="hint" style="text-align:center;margin-top:8px">Código: <b style="letter-spacing:2px">${esc(o.trackCode || '—')}</b></p>
  `;
  const ref = $('btnTrackRefresh');
  if (ref) ref.onclick = () => fetchTrack(o.trackCode, true);
  const other = $('btnTrackOther');
  if (other) other.onclick = () => { stopTracking(); renderTrackInput(); };
}

async function fetchTrack(code, fromRefresh) {
  if (!code) return;
  const res = await api(`/api/track/${encodeURIComponent(code)}`, { method: 'GET', cache: 'no-store' });
  let found = null;
  if (res && res.ok && res.order) {
    found = res.order;
    found.offline = false;
  } else {
    const local = state.orders.find(x => String(x.trackCode || '').toUpperCase() === String(code).toUpperCase());
    if (local) { found = { id: local.id, status: local.status, total: local.total, trackCode: local.trackCode, statusUpdatedAt: local.statusUpdatedAt || local.createdAt, createdAt: local.createdAt, offline: true }; }
  }
  if (!found) {
    $('trackBody').innerHTML = '<div class="empty">🚫 Pedido não encontrado.<br><small>Verifique o código digitado.</small></div>' +
      '<div style="text-align:center;margin-top:12px"><button class="btn ghost sm" id="btnTrackOther">🔍 Digitar outro código</button></div>';
    const back = $('btnTrackOther');
    if (back) back.onclick = renderTrackInput;
    stopTracking();
    return;
  }
  /* Guarda o código: é ele que o cliente pode perder depois da tela de sucesso. */
  saveMyTrack(found.trackCode || code);
  const done = isTrackDone(found);
  renderTrackBody(found, !found.offline && !done);
  if (found.offline && SERVER_OK) {
    if (found.status !== 'pendente') {
      const hint = document.createElement('p');
      hint.className = 'hint';
      hint.style.textAlign = 'center';
      hint.textContent = '⚠️ Pedido criado offline — a loja ainda não o recebeu online.';
      $('trackBody').appendChild(hint);
    }
  }
  stopTracking();
  /* Entregue/cancelado: para de consultar o servidor. */
  if (!found.offline && !done) {
    _trackTimer = setInterval(() => {
      if (!$('overlayTrack')?.classList.contains('open')) { stopTracking(); return; }
      fetchTrack(code, true);
    }, 15000);
  }
}

function renderTrackInput() {
  const body = $('trackBody');
  if (!body) return;
  const saved = getMyTracks();
  body.innerHTML = `
    ${saved.length
      ? `<p class="hint" style="margin-bottom:8px">📌 Códigos salvos neste aparelho:</p>
         <div style="display:flex;gap:8px;flex-wrap:wrap;margin-bottom:14px">
           ${saved.map(c => `<button class="btn ghost sm" data-track-chip="${esc(c)}" style="letter-spacing:2px">${esc(c)}</button>`).join('')}
         </div>
         <p class="hint" style="margin-bottom:12px">Ou digite outro código:</p>`
      : `<p class="hint" style="margin-bottom:12px">Digite o código recebido ao fazer o pedido.</p>`}
    <div style="display:flex;gap:8px">
      <input id="trackCodeInput" placeholder="Ex: K7T2M" style="flex:1;text-transform:uppercase;letter-spacing:2px" autocomplete="off">
      <button class="btn primary" id="btnTrackGo">Buscar</button>
    </div>
    <p class="hint" style="margin-top:10px">💡 O código aparece na confirmação do pedido (ex: #1234 • <b>K7T2M</b>).</p>
  `;
  const go = () => {
    const v = ($('trackCodeInput')?.value || '').trim().toUpperCase();
    if (v) fetchTrack(v, false);
  };
  $('btnTrackGo').onclick = go;
  $('trackCodeInput').onkeydown = e => { if (e.key === 'Enter') { e.preventDefault(); go(); } };
  body.querySelectorAll('[data-track-chip]').forEach(b => {
    b.onclick = () => fetchTrack(b.getAttribute('data-track-chip'), false);
  });
  $('trackCodeInput').focus();
}

function openTrack(code) {
  stopTracking();
  const body = $('trackBody');
  if (!body) return;
  $('overlayTrack').classList.add('open');

  if (!code) {
    /* Já temos código guardado aqui? Abre direto no pedido — é o que o
       cliente quer quando toca em "Acompanhar meu pedido". */
    const saved = getMyTracks();
    if (saved.length) { fetchTrack(saved[0], false); return; }
    renderTrackInput();
    return;
  }
  body.innerHTML = '<div class="empty"><div class="spinner" style="border-color:#eee;border-top-color:var(--primary);margin:0 auto 10px"></div>Consultando pedido...</div>';
  fetchTrack(code, false);
}

/* ==================== COMPARTILHAR CARDÁPIO ==================== */

function shareMenu() {
  const c = state.config;
  const url = location.href.split('#')[0];
  const text = `🥤 ${c.storeName}\n${c.slogan || ''}\n🛵 Pedido mínimo: ${brl(c.minOrder)}`;
  let done = false;
  const fallback = () => {
    if (done) return;
    done = true;
    const wa = 'https://wa.me/?text=' + encodeURIComponent(text + '\n' + url);
    navigator.clipboard?.writeText(url).catch(() => {});
    window.open(wa, '_blank');
  };
  if (navigator.share) {
    navigator.share({ title: c.storeName, text, url }).catch(err => {
      if (err && err.name === 'AbortError') return;
      fallback();
    });
    setTimeout(() => { fallback(); }, 1200);
  } else fallback();
}

/* ==================== IMPRIMIR / PDF ==================== */
function printMenu() {
  const c = state.config;
  const prods = state.products.filter(p => p.active);
  if (!prods.length) { toast('Nenhum produto no cardápio'); return; }
  const cats = [...new Set(prods.map(p => p.category).filter(Boolean))];

  let html = `<div class="ps-head">
    <h1>${esc(c.storeName)}</h1>
    <p>${esc(c.slogan || '')}</p>
    <p>${esc(c.address || '')}</p>
    <p>📞 ${esc(c.phone || c.whatsapp || '')} • Pedido mínimo ${brl(c.minOrder)}</p>
  </div>`;

  cats.forEach(cat => {
    const items = prods.filter(p => p.category === cat);
    html += `<div class="ps-cat"><h2>${esc(cat)}</h2>`;
    items.forEach(p => {
      const price = p.promo && p.promoPrice ? p.promoPrice : p.price;
      const hasVar = p.variations && p.variations.length;
      /* Variação é aditivo (+R$): o "a partir de" é base + menor adicional. */
      const minDelta = hasVar ? Math.min(...p.variations.map(v => Number(v.price) || 0)) : 0;
      const fromPrice = price + minDelta;
      const extraNote = hasVar ? `<span class="ds">${esc(p.variations.map(v => v.name + (v.price ? ' (+' + Number(v.price).toFixed(2).replace('.', ',') + ')' : '')).join(' › '))}</span>` : '';
      html += `<div class="ps-item">
        <div class="nm">${esc(p.name)}${p.promo ? ' <small style="color:#c00">🔥 promo</small>' : ''}${extraNote}<span class="ds">${esc(p.desc || '')}</span></div>
        <div class="pr">${hasVar ? 'a partir de ' : ''}R$ ${fromPrice.toFixed(2).replace('.', ',')}</div>
      </div>`;
    });
    html += `</div>`;
  });
  html += `<div class="ps-foot">Impresso em ${new Date().toLocaleString('pt-BR')} • ${esc(c.storeName)}</div>`;

  $('printSheet').innerHTML = html;
  document.body.classList.add('printing');
  window.print();
  document.body.classList.remove('printing');
}

/* ==================== MEUS PEDIDOS (no aparelho) ==================== */
function openMyOrders() {
  const list = getMyOrders();
  const el = $('myOrdersList');
  if (!el) return;
  el.innerHTML = list.length ? list.map(o => `
    <div class="my-order">
      <div class="mo-head">
        <b>#${esc((o.id || (o.items || []).map(i => i.name).join('+')).toString())}</b>
        <span class="mo-status ${o.status === 'entregue' ? 'ok' : (o.status === 'cancelado' ? '' : '')}">${esc(o.status || 'pendente')}</span>
      </div>
      <div class="mo-items">${(o.items || []).map(i => `<b>${i.qty}x</b> ${esc(i.name)}${i.variation ? ' (' + esc(i.variation) + ')' : ''}`).join(' • ')}</div>
      <div class="mo-foot">
        <span style="color:var(--primary);font-weight:700">${brl(o.total)}</span>
        <div style="display:flex;gap:6px;flex-wrap:wrap">
          <button class="btn sm primary" data-reorder-o="${o.id}">🔄 Comprar de novo</button>
          ${o.trackCode ? `<button class="btn sm ghost" data-track-o="${esc(o.trackCode)}" title="Acompanhar">🔎</button>` : ''}
        </div>
      </div>
    </div>`).join('') : '<div class="my-orders-empty">Você ainda não fez pedidos neste aparelho.<br><small>Faça um pedido e ele aparecerá aqui.</small></div>';
  $('myOrdersList').querySelectorAll('[data-reorder-o]').forEach(b => b.onclick = () => reorderMyOrder(b.dataset.reorderO));
  $('myOrdersList').querySelectorAll('[data-track-o]').forEach(b => b.onclick = () => { openTrack(b.dataset.trackO); });
  $('overlayMyOrders').classList.add('open');
}

function reorderMyOrder(id) {
  const order = getMyOrders().find(o => String(o.id) === String(id));
  if (!order) return;
  let added = 0;
  (order.items || []).forEach(it => {
    const p = state.products.find(x => x.id === it.id) || state.products.find(x => x.name === it.name);
    if (!p || p.stock <= 0) return;
    const variation = (it.variation && p.variations) ? p.variations.find(v => v.name === it.variation) || null : null;
    const extras = (it.extras || []).map(n => {
      const e = (p.extras || []).find(x => x.name === n);
      return e ? { name: e.name, price: e.price } : { name: n, price: 0 };
    });
    const qty = Math.min(it.qty || 1, p.stock);
    addToCart(p.id, qty || 1, variation, extras, it.obs || '');
    added++;
  });
  closeAll();
  stopTracking();
  if (added) {
    toast('🛒 Adicionado ao carrinho!');
    renderCart();
    openCart();
  } else {
    toast('⚠️ Os itens desse pedido não estão mais disponíveis.');
  }
}

/* ==================== V2 — BINDINGS EXTRA ==================== */
function bindExtras() {
  const btnTheme = $('btnTheme');
  if (btnTheme) btnTheme.onclick = () => { toggleTheme(); setTheme(currentTheme()); };

  const btnShare = $('btnShare');
  if (btnShare) btnShare.onclick = shareMenu;

  const btnPrint = $('btnPrint');
  if (btnPrint) btnPrint.onclick = printMenu;

  const fo = $('footerOrders');
  if (fo) fo.onclick = e => { e.preventDefault(); openMyOrders(); };
}

/* ==================== INICIALIZAÇÃO ==================== */
function hideLoader() {
  const l = $('pageLoader');
  if (l) l.classList.add('hide');
}

document.addEventListener('DOMContentLoaded', async () => {
  const loader = $('pageLoader');
  const loaderMsg = $('loaderMsg');
  if (loaderMsg) loaderMsg.textContent = 'Carregando cardápio...';

  // Rede de segurança: o loader nunca pode prender a tela. Antes, uma única
  // exceção no init deixava "Carregando cardápio..." para sempre, sem aviso.
  const watchdog = setTimeout(() => {
    if (loader && !loader.classList.contains('hide')) {
      if (loaderMsg) loaderMsg.textContent = 'Carregando devagar… recarregue se não abrir';
      hideLoader();
    }
  }, 8000);

  try {
    await init();
  } catch (e) {
    console.error('Falha na inicialização:', e);
    if (loaderMsg) loaderMsg.textContent = 'Erro ao abrir o cardápio. Recarregue a página.';
    toast('⚠️ Erro ao abrir o cardápio — recarregue a página');
    // Mostra o cardápio mesmo com falha: melhor uma tela imperfeita que nenhuma.
    $('viewMenu')?.classList.remove('hidden');
  } finally {
    clearTimeout(watchdog);
    setTimeout(hideLoader, 250);
  }
});

async function init() {
  closeAll();
  setConnUI('syncing');

  await load();
  applyTheme();
  setTheme(currentTheme());
  startConfigWatch();

  $('viewAdmin')?.classList.remove('active');
  $('viewMenu')?.classList.remove('hidden');

  document.querySelectorAll('#viewAdmin .admin-section').forEach((s, i) => s.classList.toggle('active', i === 0));

  const searchInput = $('searchInput');
  if (searchInput) searchInput.addEventListener('input', () => { activeCat = null; renderMenu(); });

  document.querySelectorAll('[data-close]').forEach(b => b.onclick = closeAll);
  document.querySelectorAll('.overlay').forEach(o => {
    o.addEventListener('click', e => { if (e.target === o) { closeAll(); if (o.id === 'overlayTrack') stopTracking(); } });
  });
  document.addEventListener('keydown', e => { if (e.key === 'Escape') { closeAll(); stopTracking(); } });

  renderCats();
  renderCart();
  renderConfig();
  renderStatus();
  renderContactInfo();

  // Conexão com o servidor
  setConnUI(SERVER_OK ? 'on' : 'off');

  // Acompanhar pedido pelo rodapé
  const ft = $('footerTrack');
  if (ft) ft.onclick = e => { e.preventDefault(); openTrack(); };

  // Extra (tema, compartilhar, imprimir, favoritos, ordem, meus pedidos)
  bindExtras();

  // Link direto: ?c=CODIGO ou /acompanhar (sem código: abre no último salvo)
  const params = new URLSearchParams(location.search);
  const trackCode = (params.get('c') || '').trim();
  const naRotaAcompanhar = /\/acompanhar\/?$/.test(location.pathname);
  if (trackCode) openTrack(trackCode);
  else if (naRotaAcompanhar) openTrack();

  // Sombra do header ao rolar
  const stickyEl = document.querySelector('.sticky');
  const onScroll = () => stickyEl?.classList.toggle('scrolled', (window.scrollY || 0) > 8);
  window.addEventListener('scroll', onScroll, { passive: true });
  onScroll();

  // PWA: service worker desabilitado para atualização instantânea
}