function renderSendBtnState() {
  const bc = $('btnConfirm');
  if (!bc) return;
  const closed = state.config.blockWhenClosed && !isStoreOpen();
  bc.disabled = closed;
  bc.textContent = closed ? '🔒 Fora do horário de funcionamento' : '✅ Enviar pelo WhatsApp';
}

/* ==================== CHECKOUT ==================== */
document.addEventListener('DOMContentLoaded', () => {
  const bf = $('btnFinish'); if (bf) bf.onclick = openCart;
  const boc = $('btnOpenCart'); if (boc) boc.onclick = openCart;

  const bc = $('btnCheckout');
  if (bc) bc.onclick = () => {
    if (!state.cart.length) { toast('Carrinho vazio'); return; }
    const { subAfterDiscount } = calcTotals({});
    if (state.config.minOrder > 0 && subAfterDiscount < state.config.minOrder) {
      /* O mínimo é sobre os PRODUTOS (a entrega não conta), então o cliente
         vê R$ 17,00 no total e não entende o bloqueio. Diz quanto falta. */
      const falta = state.config.minOrder - subAfterDiscount;
      toast(`Faltam ${brl(falta)} em produtos (mínimo ${brl(state.config.minOrder)})`);
      return;
    }
    closeAll();
    $('cPayF').innerHTML = state.config.payments.map(p => `<option>${esc(p)}</option>`).join('');
    populateBairros();
    updateFreightFields();
    updateCoSummary();
    renderSendBtnState();
    $('overlayCheckout').classList.add('open');
    if (state.config.freteMode === 'km') useCustomerLocation();
  };

  const ctf = $('cTypeF'); if (ctf) ctf.onchange = () => { updateFreightFields(); updateCoSummary(); };
  const cbf = $('cBairroF'); if (cbf) cbf.onchange = () => updateCoSummary();
  const ckf = $('cKmF');
  if (ckf) { ckf.addEventListener('input', updateCoSummary); ckf.addEventListener('change', updateCoSummary); }
  const bLocKm = $('btnLocKm'); if (bLocKm) bLocKm.onclick = useCustomerLocation;
  const ccep = $('cCepF');
  if (ccep) ccep.addEventListener('input', () => {
    const d = ccep.value.replace(/\D/g, '');
    if (d.length >= 8 && state.config.freteMode === 'km') useCustomerLocation();
  });
  const cpf = $('cPayF'); if (cpf) cpf.onchange = () => updateCoSummary();
  const cph = $('cPhoneF'); if (cph) cph.oninput = () => renderCoInfo();

  const bc2 = $('btnConfirm'); if (bc2) bc2.onclick = confirmOrder;

  // Voltar → retorna para o carrinho
  const coBack = $('btnCoBack');
  if (coBack) coBack.onclick = () => { closeAll(); openCart(); };

  // Sair → fecha tudo e volta ao cardápio
  const coExit = $('btnCoExit');
  if (coExit) coExit.onclick = () => {
    closeAll();
    window.scrollTo({ top: 0, behavior: 'smooth' });
    toast('👋 Você saiu — seu carrinho continua salvo.');
  };
});

/* Endereço estruturado (Rua, Número, Bairro, CEP) */
function buildAddr() {
  return [$('cRuaF')?.value.trim(), $('cNumF')?.value.trim(), $('cBairroNomeF')?.value.trim(), $('cCepF')?.value.trim()].filter(Boolean).join(', ');
}

function saveMyAddress(addr) {
  if (!addr) return;
  const list = getSavedAddresses().filter(a => String(a).toLowerCase() !== addr.toLowerCase());
  list.unshift(addr);
  saveAddresses(list.slice(0, 8));
}

function registerCouponUseClient() {
  if (appliedCoupon) {
    couponDeviceUse(appliedCoupon.code);
    if (appliedCoupon.type !== 'frete') {
      appliedCoupon.uses = (appliedCoupon.uses || 0) + 1;
    }
  }
}

function populateBairros() {
  const sel = $('cBairroF');
  if (!sel) return;
  sel.innerHTML = '<option value="">— Selecione —</option>' +
    state.bairros.map(b => `<option value="${esc(b.id)}">${esc(b.name)} (${brl(b.tax)})</option>`).join('');
}

function updateFreightFields() {
  const type = $('cTypeF').value;
  const mode = state.config.freteMode;
  const isEntrega = type === 'Entrega';

  $('addrWrap').style.display = isEntrega ? 'block' : 'none';
  $('bairroWrap').style.display = isEntrega ? 'grid' : 'none';

  const kmWrap = $('kmWrap'); if (kmWrap) kmWrap.style.display = (isEntrega && mode === 'km') ? 'block' : 'none';
  $('cBairroF').parentElement.style.display = (isEntrega && mode === 'bairro') ? 'block' : 'none';
}

function getFreightOpts() {
  return {
    type: $('cTypeF').value,
    bairroId: $('cBairroF').value,
    km: parseFloat($('cKmF').value) || 0
  };
}

/* Distância em linha reta (Km) entre dois pontos — fórmula de Haversine */
function haversineKm(lat1, lng1, lat2, lng2) {
  const R = 6371;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLng = (lng2 - lng1) * Math.PI / 180;
  const a = Math.sin(dLat / 2) ** 2 +
            Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) * Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function parseStoreCoords() {
  const raw = (state.config.storeCoords || '').trim();
  if (!raw) return null;
  const p = raw.split(',').map(x => parseFloat(x.trim()));
  if (p.length < 2 || isNaN(p[0]) || isNaN(p[1])) return null;
  return { lat: p[0], lng: p[1] };
}

function setDist(text, color) {
  const line = $('distLine'); if (!line) return;
  line.innerHTML = text;
  line.style.color = color || 'var(--text)';
}

/* Distância pelo CEP (BrasilAPI, grátis e sem chave) — retorna km ou null */
async function cepKm(cep, store) {
  try {
    const r = await fetch('https://brasilapi.com.br/api/cep/v2/' + cep);
    if (!r.ok) return null;
    const j = await r.json();
    const c = j.location && j.location.coordinates;
    const lat = parseFloat(c && c.latitude);
    const lng = parseFloat(c && c.longitude);
    if (isNaN(lat) || isNaN(lng)) return null;
    return haversineKm(lat, lng, store.lat, store.lng);
  } catch (e) { return null; }
}

function applyKm(km) {
  const kmIn = $('cKmF'); if (!kmIn) return;
  const cfg = state.config;
  const k = Number((km || 0).toFixed(1)) || 0;
  kmIn.value = String(k);
  updateCoSummary();
  if (cfg.freteKmGratis > 0 && k >= cfg.freteKmGratis) {
    setDist(`📍 Distância: ~${k} km • 🛵 Frete grátis!`, 'var(--success)');
  } else {
    setDist(`📍 Distância: ~${k} km • 🛵 Frete: ${brl(k * (Number(cfg.freteKmVal) || 0))}`, 'var(--text)');
  }
  const hint = $('cKmHint'); if (hint) hint.textContent = '';
}

/* Calcula a distância automaticamente: 1º pelo CEP, 2º pelo GPS.
   Antes de calcular, busca a configuração atual no servidor — sem isso, uma aba
   aberta antes de o lojista corrigir a localização continuaria medindo a
   distância a partir do ponto antigo (o erro do cliente usando o lugar errado). */
async function useCustomerLocation() {
  const kmIn = $('cKmF'); if (!kmIn) return;
  const hint = $('cKmHint');
  const line = $('distLine');

  if (typeof pullPublic === 'function' && !isAdminUnlocked()) {
    if (line) { line.textContent = '📍 Atualizando dados da loja...'; }
    await pullPublic();
    updateFreightFields();
  }

  const store = parseStoreCoords();

  if (!store) {
    kmIn.value = '';
    setDist('🛵 Frete a combinar — a loja confirma no WhatsApp', 'var(--warning)');
    if (hint) { hint.textContent = 'A loja ainda não cadastrou a localização (Admin → Config).'; hint.style.color = 'var(--muted)'; }
    updateCoSummary();
    return;
  }

  const cep = ($('cCepF')?.value || '').replace(/\D/g, '');
  if (cep.length === 8) {
    setDist('📍 Calculando pelo CEP...', 'var(--muted)');
    cepKm(cep, store).then(km => {
      if (km != null) { applyKm(km); return; }
      gpsFallback(store, hint);
    });
    return;
  }

  gpsFallback(store, hint);
}

function gpsFallback(store, hint) {
  const kmIn = $('cKmF');
  if (!navigator.geolocation) {
    kmIn.value = '';
    updateCoSummary();
    setDist('🛵 Frete a combinar — a loja confirma no WhatsApp', 'var(--warning)');
    if (hint) { hint.textContent = 'Navegador sem localização.'; hint.style.color = 'var(--muted)'; }
    return;
  }
  setDist('📍 Calculando pela sua localização...', 'var(--muted)');
  navigator.geolocation.getCurrentPosition(
    pos => applyKm(haversineKm(pos.coords.latitude, pos.coords.longitude, store.lat, store.lng)),
    () => {
      kmIn.value = '';
      updateCoSummary();
      setDist('🛵 Frete a combinar — a loja confirma no WhatsApp', 'var(--warning)');
      if (hint) { hint.textContent = 'Permita a localização ou informe o CEP.'; hint.style.color = 'var(--muted)'; }
      toast('Permita a localização ou digite o CEP para calcular o frete');
    },
    { enableHighAccuracy: true, timeout: 12000 }
  );
}

function renderCoItems() {
  const el = $('coItems');
  if (!el) return;
  if (!state.cart.length) { el.innerHTML = ''; return; }
  const lines = state.cart.map(c => {
    const p = state.products.find(x => x.id === c.id);
    if (!p) return '';
    const unit = calcItemPrice(p, c.variation, c.extras || []);
    const det = [
      c.variation ? c.variation.name : '',
      (c.extras || []).length ? '+' + c.extras.map(e => e.name).join(', ') : '',
      c.obs ? '📝 ' + c.obs : ''
    ].filter(Boolean).join(' • ');
    return `<div class="review-line">
      <span class="rr-name"><b>${c.qty}x</b> ${esc(p.name)}${det ? `<br><small>${esc(det)}</small>` : ''}</span>
      <span>${brl(unit * c.qty)}</span>
    </div>`;
  }).join('');
  const count = state.cart.reduce((s, c) => s + c.qty, 0);
  el.innerHTML = `<div class="order-review">
    <h3>🛒 Resumo do pedido <span>${count} ${count === 1 ? 'item' : 'itens'}</span></h3>
    ${lines}
  </div>`;
}

function renderCoInfo() {
  const el = $('coInfo');
  if (!el) return;
  const type = $('cTypeF')?.value || 'Entrega';
  const pay = $('cPayF')?.value || '—';
  const phone = $('cPhoneF')?.value.trim() || '';
  el.innerHTML = `<div class="co-note">
    <div>🛒 Tipo: <b>${esc(type)}</b> • 💳 Pagamento: <b>${esc(pay)}</b>${pay === 'Dinheiro' ? ' <span style="opacity:.8">(informe o troco acima, se precisar)</span>' : ''}</div>
    <div>🕒 Entrega estimada: <b>${esc(state.config.deliveryTime || '—')}</b></div>
    ${state.config.minOrder > 0 ? `<div>💰 Pedido mínimo: <b>${brl(state.config.minOrder)}</b></div>` : ''}
    ${!phone ? '<div>📞 Dica: informe seu telefone para o entregador conseguir contato.</div>' : ''}
    <div>📲 Ao enviar, finalize no WhatsApp. Você receberá um <b>código</b> para acompanhar o pedido.</div>
  </div>`;
}

function updateCoSummary() {
  const opts = getFreightOpts();
  const { sub, discount, del } = calcTotals(opts);
  const finalTot = sub - discount + del;
  const freightText = (!opts.km && opts.type === 'Entrega' && state.config.freteMode === 'km')
    ? 'a combinar'
    : brl(del);
  $('coSummary').innerHTML = `
    <div class="row"><span>Subtotal</span><span>${brl(sub)}</span></div>
    ${discount ? `<div class="row" style="color:var(--success)"><span>Desconto</span><span>− ${brl(discount)}</span></div>` : ''}
    <div class="row"><span>Frete ${opts.type==='Retirada'?'(retirada)':''}</span><span>${freightText}</span></div>
    <div class="row tot"><span>Total</span><span>${brl(finalTot)}</span></div>
  `;
  renderCoItems();
  renderCoInfo();
  updateKmHint();
}

function updateKmHint() {
  const hint = $('cKmHint'); if (!hint) return;
  const opts = getFreightOpts();
  const cfg = state.config;
  if (opts.type === 'Retirada' || cfg.freteMode !== 'km') { hint.textContent = ''; return; }
  if (opts.km <= 0) {
    hint.textContent = 'Se não conseguir localizar, o frete é combinado com a loja no WhatsApp.';
    hint.style.color = 'var(--muted)';
    return;
  }
  hint.textContent = '';
}

/* ==================== CONFIRMAÇÃO / SUCESSO ==================== */
function copyText(txt) {
  if (navigator.clipboard) { navigator.clipboard.writeText(txt); return true; }
  try { const ta = document.createElement('textarea'); ta.value = txt; document.body.appendChild(ta); ta.select(); document.execCommand('copy'); ta.remove(); return true; } catch(e) { return false; }
}

function showOrderSuccess(data) {
  const o = data || {};
  /* Guarda o código na hora: é a única vez que ele é mostrado e o cliente
     pode fechar a tela sem anotar. Ver state.js → getMyTracks(). */
  if (o.trackCode) saveMyTrack(o.trackCode);
  $('succNum').textContent = '#' + (o.id || '—');
  $('succTotal').textContent = brl(o.total);
  $('succPay').textContent = o.payment || '—';
  $('succTime').textContent = state.config.deliveryTime || '—';
  $('succCode').textContent = o.trackCode || '—';
  $('succCode').onclick = () => { if (o.trackCode) copyText(o.trackCode) && toast('📋 Código copiado!'); };
  $('succNote').textContent = o.offline
    ? 'Modo offline: o pedido foi salvo só neste aparelho e não poderá ser acompanhado.'
    : 'Envie o pedido no WhatsApp para confirmar a compra.';
  const wa = $('succWa');
  wa.onclick = () => window.open(o.waUrl, '_blank');
  const tr = $('succTrack');
  if (tr) {
    tr.classList.toggle('hidden', !o.trackCode);
    tr.onclick = () => { closeAll(); openTrack(o.trackCode); };
  }
  renderPixOnSuccess(o);
  $('overlaySuccess').classList.add('open');
  if (navigator.vibrate) navigator.vibrate([60, 40, 60]);
}

function renderPixOnSuccess(o) {
  const box = $('succPix');
  if (!box) return;
  const cfg = state.config;
  const show = !o.offline && String(o.payment || '').toLowerCase() === 'pix' && cfg.pix;
  box.classList.toggle('hidden', !show);
  if (!show) return;
  const payload = pixPayload(o.total, cfg.pix, cfg.pixName || cfg.storeName || 'Minha Loja', cfg.pixCity || 'Brasil', '#' + o.id);
  const qrEl = $('pixQR');
  if (qrEl) {
    if (typeof QRCode === 'function') {
      try { qrEl.innerHTML = ''; new QRCode(qrEl, { text: payload, width: 190, height: 190 }); } catch (e) { qrEl.innerHTML = '<small>Erro ao gerar QR</small>'; }
    } else {
      qrEl.innerHTML = '<small>QR indisponível</small>';
    }
  }
  const copy = $('pixCopy');
  if (copy) copy.value = payload;
  const cb = $('btnCopyPix');
  if (cb) cb.onclick = () => { copyText(payload) ? toast('📋 Código PIX copiado!') : toast('Não foi possível copiar'); };
}

async function confirmOrder() {
  if (confirmOrder.busy) return;
  confirmOrder.busy = true;

  if (state.config.blockWhenClosed && !isStoreOpen()) {
    toast('🔒 Estamos fora do horário de funcionamento — o envio de pedidos está desativado.');
    confirmOrder.busy = false;
    return;
  }

  const name = $('cNameF').value.trim();
  if (!name) { toast('Informe seu nome'); confirmOrder.busy = false; return; }
  const type = $('cTypeF').value;
  const payment = $('cPayF').value;
  const addr = buildAddr();
  const obs = $('cObsF').value.trim();
  const phone = $('cPhoneF').value.trim().replace(/\D/g,'');
  const change = $('cChangeF').value.trim();
  const bairroId = $('cBairroF').value;
  const km = parseFloat($('cKmF').value) || 0;

  if (type === 'Entrega' && !addr) { toast('Informe o endereço'); confirmOrder.busy = false; return; }
  if (type === 'Entrega' && addr.length < 5) { toast('Endereço incompleto'); confirmOrder.busy = false; return; }
  if (phone && phone.length < 10) { toast('Telefone inválido — use com DDD'); confirmOrder.busy = false; return; }
  if (type === 'Entrega' && state.config.freteMode === 'bairro' && !bairroId) { toast('Selecione o bairro'); confirmOrder.busy = false; return; }

  const { tot: totalPre } = calcTotals({ type, bairroId, km });
  if (payment === 'Dinheiro' && change) {
    const ch = parseFloat(change);
    if (!isNaN(ch) && ch < totalPre) { toast(`Troco para R$ ${ch.toFixed(2)} é menor que o total (${brl(totalPre)})`); confirmOrder.busy = false; return; }
  }

  const button = $('btnConfirm');
  if (button) { button.disabled = true; button.textContent = '⏳ Enviando...'; }

  const payload = {
    customer: name, phone, address: addr, type, payment, notes: obs, change,
    bairroId, km,
    coupon: appliedCoupon ? appliedCoupon.code : '',
    items: state.cart.map(c => ({
      id: c.id,
      qty: c.qty,
      variation: c.variation ? c.variation.name : '',
      extras: (c.extras || []).map(e => e.name),
      obs: c.obs || ''
    }))
  };

  try {
    if (SERVER_OK) {
      const res = await api('/api/orders', { method: 'POST', body: payload });
      if (res && res.ok) {
        registerCouponUseClient();
        if (type === 'Entrega' && addr) saveMyAddress(addr);
        pushMyOrder({
          id: res.order.id,
          trackCode: res.order.trackCode || null,
          status: res.order.status || 'pendente',
          total: res.order.total,
          createdAt: new Date().toISOString(),
          items: state.cart.map(c => ({ id: c.id, name: (state.products.find(p => p.id === c.id) || {}).name || '', qty: c.qty, variation: c.variation ? c.variation.name : '', extras: (c.extras || []).map(e => e.name), obs: c.obs || '' }))
        });
        state.cart = []; appliedCoupon = null; saveLocalOnly();
        closeAll(); renderCart(); renderMenu();
        showOrderSuccess({ id: res.order.id, total: res.order.total, payment: res.order.payment, trackCode: res.order.trackCode, waUrl: res.waUrl });
        refreshFromServer().then(() => { renderMenu(); renderCart(); });
        return;
      }
      if (res && res.error) {
        if (res.code === 'STORE_CLOSED') { toast('⚠️ ' + res.error); return; }
        if (res.code && res.code.startsWith('COUPON')) { appliedCoupon = null; renderCart(); toast('❌ ' + res.error); return; }
        toast('❌ ' + res.error);
        if (res.code === 'COUPON_LIMIT') { appliedCoupon = null; renderCart(); }
        return;
      }
      await fallbackOrder(payload, { name, phone, type, payment, addr, obs, change, bairroId, km });
      return;
    }
    await fallbackOrder(payload, { name, phone, type, payment, addr, obs, change, bairroId, km });
  } finally {
    confirmOrder.busy = false;
    if (button) { button.disabled = false; button.textContent = '✅ Enviar pelo WhatsApp'; }
  }
}

async function fallbackOrder(payload, meta) {
  const { name, phone, type, payment, addr, obs, change, bairroId, km } = meta;
  const items = state.cart.map(c => {
    const p = state.products.find(x => x.id === c.id);
    const unit = calcItemPrice(p, c.variation, c.extras||[]);
    return { name: p.name, variation: c.variation ? c.variation.name : '', extras: (c.extras||[]).map(e => e.name), obs: c.obs || '', qty: c.qty, unit, total: unit * c.qty };
  });
  const freightOpts = { type, bairroId, km };
  const { sub, discount, del, tot } = calcTotals(freightOpts);
  const bairroName = bairroId ? (state.bairros.find(b => b.id === bairroId)?.name || '') : '';
  const trackCode = 'L' + Math.random().toString(36).slice(2,7).toUpperCase();
  /* Número sequencial (1, 2, 3...) igual ao servidor — não Date.now(). */
  const localNum = (state.orders || []).reduce((m, o) => Math.max(m, Number(o.id) || 0), 0) + 1;
  const order = {
    id: localNum, trackCode, customer: name, phone, address: addr, type, payment, notes: obs, change,
    bairro: bairroName, km: km || null,
    items, subtotal: sub, discount,
    coupon: appliedCoupon ? appliedCoupon.code : '',
    delivery: del, total: tot,
    status: 'pendente',
    statusUpdatedAt: new Date().toISOString(),
    createdAt: new Date().toISOString()
  };
  state.cart.forEach(c => {
    const p = state.products.find(x => x.id === c.id);
    if (p) p.stock = Math.max(0, p.stock - c.qty);
  });
  registerCouponUseClient();
  if (type === 'Entrega' && addr) saveMyAddress(addr);
  state.orders.unshift(order);
  state.cart = []; appliedCoupon = null;
  saveLocalOnly();

  let m = `*🥤 NOVO PEDIDO #${order.id}*\n\n`;
  m += `*Cliente:* ${name}\n`;
  if (phone) m += `*Telefone:* ${phone}\n`;
  m += `*Tipo:* ${type}\n`;
  if (type === 'Entrega' && addr) m += `*Endereço:* ${addr}\n`;
  if (bairroName) m += `*Bairro:* ${bairroName}\n`;
  if (km) m += `*Distância:* ${km} km\n`;
  m += `*Pagamento:* ${payment}\n`;
  if (change) m += `*Troco para:* ${change}\n`;
  m += `\n*ITENS:*\n`;
  items.forEach(i => {
    m += `• ${i.qty}x ${i.name}${i.variation?' ('+i.variation+')':''}`;
    if (i.extras.length) m += ` + ${i.extras.join(', ')}`;
    m += ` — ${brl(i.total)}\n`;
    if (i.obs) m += `   📝 _${i.obs}_\n`;
  });
  m += `\n*Subtotal:* ${brl(sub)}`;
  if (discount) m += `\n*Desconto (${order.coupon}):* − ${brl(discount)}`;
  if (del) m += `\n*Frete:* ${brl(del)}`;
  m += `\n*TOTAL:* ${brl(tot)}`;
  if (obs) m += `\n\n*Obs geral:* ${obs}`;
  if (payment === 'Pix' && state.config.pix) {
    const payload = pixPayload(tot, state.config.pix, state.config.pixName || state.config.storeName || 'Minha Loja', state.config.pixCity || 'Brasil', '#' + order.id);
    m += `\n\n*CHAVE PIX PARA PAGAR:*\n${payload}`;
  }

  const waUrl = `https://wa.me/${state.config.whatsapp}?text=${encodeURIComponent(m)}`;
  window.open(waUrl, '_blank');

  closeAll();
  renderCart(); renderMenu();
  pushMyOrder({
    id: order.id,
    trackCode: null,
    status: 'pendente',
    total: tot,
    createdAt: new Date().toISOString(),
    items: items.map(i => ({ name: i.name, qty: i.qty, variation: i.variation, extras: i.extras, obs: i.obs }))
  });
  showOrderSuccess({ id: order.id, total: tot, payment, trackCode: null, waUrl, offline: true });
}