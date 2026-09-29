/* ==================== CARRINHO ==================== */
function itemSignature(id, variation, extras, obs) {
  const vkey = variation ? variation.name : '';
  const ekey = (extras||[]).map(e => e.name).sort().join('|');
  return `${id}__${vkey}__${ekey}__${obs}`;
}

/* Variação e extra são aditivos (+R$) — é o que o editor do painel pede
   (placeholder "+R$") e o que o seed de dados usa. Tratar a variação como
   preço absoluto zera o item quando a variação custa 0. */
function calcItemPrice(p, variation, extras) {
  const base = p.promo && p.promoPrice ? p.promoPrice : p.price;
  const vAdd = variation ? (Number(variation.price) || 0) : 0;
  const eAdd = (extras||[]).reduce((s,e) => s + (Number(e.price) || 0), 0);
  return base + vAdd + eAdd;
}

function addToCart(id, qty=1, variation=null, extras=[], obs='') {
  const p = state.products.find(x => x.id === id);
  if (!p || p.stock <= 0) return;
  if (state.config.requireAge && !ageConfirmed() && isAlcoholic(p)) {
    toast('🔞 Este item requer +18. Toque no produto para confirmar a idade.');
    return;
  }
  const sig = itemSignature(id, variation, extras, obs);
  const ex = state.cart.find(c => c.sig === sig);
  const totalQty = state.cart.filter(c => c.id === id).reduce((s,c) => s + c.qty, 0);
  if (totalQty + qty > p.stock) { toast('Estoque insuficiente!'); return; }
  if (ex) ex.qty += qty;
  else state.cart.push({ sig, id, qty, variation, extras, obs });
  save(); renderCart();
  toast('✅ Adicionado ao carrinho');
}

function changeQty(sig, delta) {
  const item = state.cart.find(c => c.sig === sig);
  if (!item) return;
  const p = state.products.find(x => x.id === item.id);
  if (!p) return;
  const n = item.qty + delta;
  if (n <= 0) state.cart = state.cart.filter(c => c.sig !== sig);
  else {
    const otherQty = state.cart.filter(c => c.id === item.id && c.sig !== sig).reduce((s,c) => s + c.qty, 0);
    if (delta > 0 && otherQty + n > p.stock) { toast('Estoque insuficiente!'); return; }
    item.qty = n;
  }
  save(); renderCart();
}

function removeItem(sig) {
  state.cart = state.cart.filter(c => c.sig !== sig);
  save(); renderCart();
}

/* ==================== CUPOM ==================== */
let appliedCoupon = null;

function applyCouponCode(code) {
  const c = state.coupons.find(x => x.code.toUpperCase() === code.toUpperCase() && x.active);
  if (!c) { appliedCoupon = null; return { ok:false, msg:'Cupom inválido' }; }
  if (c.limit && c.uses >= c.limit) { appliedCoupon = null; return { ok:false, msg:'Cupom esgotado' }; }
  if (c.per > 0 && couponDeviceUses(c.code) >= c.per) { appliedCoupon = null; return { ok:false, msg:'Você já usou este cupom neste aparelho' }; }
  if (c.first && couponDeviceUses(c.code) >= 1) { appliedCoupon = null; return { ok:false, msg:'Este cupom é só para a primeira compra' }; }
  const sub = calcSubtotal();
  if (Number(c.min) > 0 && sub < Number(c.min)) { appliedCoupon = null; return { ok:false, msg:`Mínimo ${brl(Number(c.min))} para este cupom` }; }
  appliedCoupon = c;
  return { ok:true, msg:`✅ Cupom "${c.code}" aplicado` };
}

function calcCouponDiscount(subtotal) {
  if (!appliedCoupon) return 0;
  if (Number(appliedCoupon.min) > 0 && subtotal < Number(appliedCoupon.min)) return 0;
  if (appliedCoupon.type === 'frete') return 0;
  if (appliedCoupon.type === 'percent') return subtotal * appliedCoupon.value / 100;
  return Math.min(appliedCoupon.value, subtotal);
}

function calcSubtotal() {
  return state.cart.reduce((s,c) => {
    const p = state.products.find(x => x.id === c.id);
    if (!p) return s;
    return s + calcItemPrice(p, c.variation, c.extras||[]) * c.qty;
  }, 0);
}

/* ==================== FRETE ==================== */
function calcFreight(subtotal, opts = {}) {
  const cfg = state.config;
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
      const b = state.bairros.find(x => x.id === opts.bairroId);
      return b ? Number(b.tax) || 0 : 0;
    }
    default: return Number(cfg.freteFixo) || 0;
  }
}

function calcTotals(freightOpts = {}) {
  const sub = calcSubtotal();
  const discount = calcCouponDiscount(sub);
  const freeFreight = !!(appliedCoupon && appliedCoupon.type === 'frete' && freightOpts.type !== 'Retirada');
  const subAfterDiscount = Math.max(0, sub - discount);
  const del = freeFreight || subAfterDiscount <= 0 ? 0 : calcFreight(subAfterDiscount, freightOpts);
  return { sub, discount, freeFreight, subAfterDiscount, del, tot: subAfterDiscount + del };
}

/* ==================== DETALHES DO CARRINHO (ajuda o cliente) ==================== */
function freightHint() {
  const c = state.config;
  if (c.freteMode === 'gratis') return 'Grátis';
  if (c.freteGratisAcima > 0) return `Grátis acima de ${brl(c.freteGratisAcima)}`;
  if (c.freteMode === 'fixo') return brl(c.freteFixo || 0);
  if (c.freteMode === 'km') return `${brl(c.freteKmVal || 0)}/km${c.freteKmGratis > 0 ? ` • grátis até ${c.freteKmGratis}km` : ''}`;
  if (c.freteMode === 'bairro') return 'conforme o bairro';
  return brl(c.freteFixo || 0);
}

function renderCartExtra(sub) {
  const el = $('cartExtra');
  if (!el) return;
  if (!state.cart.length) { el.innerHTML = ''; return; }
  const c = state.config;
  const min = c.minOrder || 0;
  const falta = min - sub;
  el.innerHTML = `<div class="co-note">
    ${min > 0 ? (falta > 0
      ? `<div class="co-warn">⚠️ Faltam <b>${brl(falta)}</b> para o pedido mínimo de ${brl(min)}</div>`
      : `<div class="co-ok">✅ Pedido mínimo atingido (${brl(min)})</div>`) : ''}
    <div>🕒 Entrega estimada: <b>${esc(c.deliveryTime || '—')}</b></div>
    <div>🛵 Frete: <b>${appliedCoupon && appliedCoupon.type === 'frete' ? 'Grátis 🎉' : freightHint()}</b> <span style="opacity:.8">(estimado — confirmado no próximo passo)</span></div>
    ${appliedCoupon
      ? `<div>🎟️ Cupom <b>${esc(appliedCoupon.code)}</b> aplicado${appliedCoupon.type === 'frete' ? ' (frete grátis)' : ''}</div>`
      : '<div>🎟️ Tem um cupom? Digite o código acima e toque em <b>Aplicar</b>.</div>'}
  </div>`;
}

/* ==================== RENDER CARRINHO ==================== */
function renderCart() {
  const items = state.cart.reduce((s,c) => s + c.qty, 0);
  const badge = $('cartCount');
  if (badge) {
    if (items > 0) { badge.classList.remove('hidden'); badge.textContent = items; }
    else badge.classList.add('hidden');
  }

  const { sub, discount, del, tot } = calcTotals({ type:'Entrega' });
  const bar = $('cartBar');
  if (bar) {
    if (items > 0) {
      bar.classList.add('visible');
      $('cartInfo').textContent = items + ' item' + (items>1?'s':'');
      $('cartTotalBar').textContent = brl(tot);
    } else bar.classList.remove('visible');
  }

  const cartLines = $('cartLines');
  if (!cartLines) return;

  if (!state.cart.length) {
    cartLines.innerHTML = '<div class="empty">🛒 Seu carrinho está vazio.<br><small>Adicione produtos para começar seu pedido.</small></div>';
    $('cartSummary').innerHTML = '';
    $('couponMsg').innerHTML = '';
    const ce = $('cartExtra'); if (ce) ce.innerHTML = '';
    appliedCoupon = null;
  } else {
    cartLines.innerHTML = state.cart.map(c => {
      const p = state.products.find(x => x.id === c.id);
      if (!p) return '';
      const unitPrice = calcItemPrice(p, c.variation, c.extras||[]);
      const imgContent = p.image && (p.image.startsWith('http')||p.image.startsWith('data:')||p.image.startsWith('assets/'))
        ? `<img src="${esc(p.image)}" style="width:100%;height:100%;object-fit:cover;border-radius:10px">`
        : esc(p.image || '🥤');
      const varText = c.variation ? ` • ${esc(c.variation.name)}` : '';
      const extrasText = c.extras && c.extras.length ? ` • +${esc(c.extras.map(e=>e.name).join(', '))}` : '';
      const obsText = c.obs ? `<div class="obs-tag">📝 ${esc(c.obs)}</div>` : '';
      return `
        <div class="cart-line">
          <div class="thumb" style="background:${thumbBg(p.category)}">${imgContent}</div>
          <div class="info">
            <strong>${esc(p.name)}</strong>
            <small>${brl(unitPrice)}${varText}${extrasText} × ${c.qty} = <b>${brl(unitPrice*c.qty)}</b></small>
            ${obsText}
          </div>
          <div class="qty">
            <button data-dec="${c.sig}">−</button>
            <span>${c.qty}</span>
            <button data-inc="${c.sig}">+</button>
          </div>
          <button class="btn sm danger" data-del="${c.sig}" style="border-radius:50%;padding:4px 8px">🗑</button>
        </div>`;
    }).join('');
    cartLines.querySelectorAll('[data-inc]').forEach(b => b.onclick = () => changeQty(b.dataset.inc, 1));
    cartLines.querySelectorAll('[data-dec]').forEach(b => b.onclick = () => changeQty(b.dataset.dec, -1));
    cartLines.querySelectorAll('[data-del]').forEach(b => b.onclick = () => removeItem(b.dataset.del));

    $('cartSummary').innerHTML = `
      <div class="row"><span>Subtotal (${items} ${items === 1 ? 'item' : 'itens'})</span><span>${brl(sub)}</span></div>
      ${discount ? `<div class="row" style="color:var(--success)"><span>Desconto</span><span>− ${brl(discount)}</span></div>` : ''}
      <div class="row"><span>Frete (estimado)</span><span>${brl(del)}</span></div>
      <div class="row tot"><span>Total</span><span>${brl(tot)}</span></div>
    `;
    renderCartExtra(sub);
  }
}

function openCart() {
  if (appliedCoupon) {
    $('couponMsg').innerHTML = `<div class="coupon-ok">✅ Cupom "${esc(appliedCoupon.code)}" ativo</div>`;
    $('couponInput').value = appliedCoupon.code;
  }
  $('overlayCart').classList.add('open');
}

document.addEventListener('DOMContentLoaded', () => {
  const btn = $('btnApplyCoupon');
  if (btn) btn.onclick = () => {
    const code = $('couponInput').value.trim();
    if (!code) return;
    const r = applyCouponCode(code);
    $('couponMsg').innerHTML = r.ok
      ? `<div class="coupon-ok">${esc(r.msg)}</div>`
      : `<div class="coupon-err">❌ ${esc(r.msg)}</div>`;
    renderCart();
  };

  // Voltar → fecha o carrinho e retorna ao cardápio
  const back = $('btnCartBack');
  if (back) back.onclick = () => closeAll();

  // Sair → fecha tudo e volta para o topo do cardápio
  const exit = $('btnCartExit');
  if (exit) exit.onclick = () => {
    closeAll();
    window.scrollTo({ top: 0, behavior: 'smooth' });
    toast('👋 Você saiu do carrinho — seu pedido continua salvo aqui.');
  };
});