/* ==================== MENU (chips horizontais + vertical c/ submenu + busca) ==================== */
let openCategory = null;
let activeCat = null;

/**
 * Remove acentos/tom e deixa minúsculo (busca sem depender de acentuação)
 */
function norm(s) {
  return String(s || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/ç/g, 'c')
    .toLowerCase();
}

/**
 * Verifica se um produto bate com o termo de busca (ignora acentos, ç, case)
 * Busca apenas pelo NOME do produto
 * Aceita 1, 2, 3+ letras
 */
function productMatches(p, q) {
  if (!p.active) return false;
  if (!q) return true;
  const terms = norm(q).split(/\s+/).filter(Boolean);
  const hay = norm(p.name);
  return terms.every(t => {
    return hay.split(/\s+/).some(w => w.startsWith(t));
  });
}

/**
 * Destaca o termo buscado no texto (compara ignorando acentos)
 */
function highlight(text, q) {
  const raw = text == null ? '' : String(text);
  if (!q || !raw) return esc(raw);
  const nq = norm(q);
  if (!nq) return esc(raw);
  let plain = '', off = [];
  for (let oi = 0; oi < raw.length; oi++) {
    const clean = String(raw[oi]).normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
    if (clean) { plain += clean; off.push(oi); }
  }
  const i = plain.indexOf(nq);
  if (i === -1) return esc(raw);
  const start = off[i];
  const end = off[i + nq.length - 1] + 1;
  return esc(raw.slice(0, start)) + '<mark class="hl">' + esc(raw.slice(start, end)) + '</mark>' + esc(raw.slice(end));
}

/* Preço efetivo (promoção) */
function priceNow(p) { return p.promo && p.promoPrice ? p.promoPrice : p.price; }

/**
 * Barra horizontal de categorias (acima da busca) para seleção rápida.
 * "Todos" volta para o cardápio completo; clicar de novo na categoria ativa
 * também volta para "Todos".
 */
function renderCatChips() {
  const wrap = $('catChips');
  if (!wrap) return;

  const q = ($('searchInput')?.value || '').trim();
  const searching = q.length > 0;
  if (searching) activeCat = null;

  const allCats = [...new Set(state.products.filter(p => p.active).map(p => p.category).filter(Boolean))];
  if (!allCats.length) { wrap.innerHTML = ''; wrap.classList.add('empty'); return; }
  wrap.classList.remove('empty');

  const pool = state.products.filter(p => p.active && (!searching || productMatches(p, q)));
  const chips = [{ cat: null, label: 'Todos', emoji: '🏠', n: pool.length }];
  allCats.forEach(cat => chips.push({ cat, label: cat, emoji: categoryEmoji(cat), n: pool.filter(p => p.category === cat).length }));

  wrap.innerHTML = chips.map(c => `
    <button type="button" class="cat-chip${activeCat === c.cat ? ' active' : ''}" data-cat="${esc(c.cat || '')}" aria-pressed="${activeCat === c.cat}">
      <span class="cc-emoji">${c.emoji}</span>
      <span class="cc-label">${esc(c.label)}</span>
      <span class="cc-n">${c.n}</span>
    </button>`).join('');

  wrap.querySelectorAll('.cat-chip').forEach(b => {
    b.onclick = () => {
      const cat = b.dataset.cat || null;
      activeCat = (activeCat === cat) ? null : cat;
      openCategory = activeCat;
      renderCats();
      const on = wrap.querySelector('.cat-chip.active');
      if (on) on.scrollIntoView({ inline: 'center', block: 'nearest', behavior: 'smooth' });
    };
  });
}

function renderCats() {
  const catNav = $('catNav');
  renderCatChips();
  if (!catNav) return;
  catNav.innerHTML = '';

  const q = ($('searchInput')?.value || '').trim();
  const searching = q.length > 0;

  // Todas as categorias existentes
  const allCats = [...new Set(state.products.filter(p => p.active).map(p => p.category).filter(Boolean))];

  // Pool de produtos que casam com a busca
  const pool = state.products.filter(p =>
    p.active &&
    (!searching || productMatches(p, q))
  );

  // Busca sem resultado global
  if (searching && pool.length === 0) {
    const div = document.createElement('div');
    div.className = 'search-empty';
    div.innerHTML = `😕 Nenhum produto encontrado para "<b>${esc(q)}</b>"<br><small style="font-size:.8rem">Tente outro termo</small>`;
    catNav.appendChild(div);
    return;
  }

  // Separa categorias: com match (topo) e sem match (base)
  const catsWithMatch = [];
  const catsWithoutMatch = [];

  allCats.forEach(cat => {
    const items = searching ? pool.filter(p => p.category === cat) : state.products.filter(p => p.active && p.category === cat);
    if (searching && items.length === 0) {
      catsWithoutMatch.push({ cat, items });
    } else {
      catsWithMatch.push({ cat, items });
    }
  });

  // Ordem: com match primeiro, depois sem match
  let orderedCats = [...catsWithMatch, ...catsWithoutMatch];

  // Chip horizontal ativo: mostra só aquela categoria, já expandida
  if (activeCat) orderedCats = orderedCats.filter(x => x.cat === activeCat);

  const frag = document.createDocumentFragment();

  orderedCats.forEach(({ cat, items }) => {
    const hasMatch = searching && items.length > 0;
    const emoji = categoryEmoji(cat);
    // Com match: aberto. Sem match: fechado. Sem busca: toggle normal
    const isOpen = searching ? hasMatch : (openCategory === cat);

    // Botão da categoria
    const btn = document.createElement('button');
    btn.className = 'cat-toggle' + (isOpen ? ' active' : '');
    btn.dataset.cat = cat;
    btn.setAttribute('aria-expanded', isOpen);
    btn.innerHTML = `
      <span class="cat-info">
        <span class="cat-emoji">${emoji}</span>
        <span>${esc(cat)}</span>
      </span>
      <span style="display:flex;align-items:center;gap:8px">
        <span class="cat-count">${items.length}</span>
        <span class="arrow">▾</span>
      </span>`;

    // Sempre permite toggle, mesmo durante busca
    btn.onclick = () => {
      const sub = catNav.querySelector('[data-submenu="' + cat + '"]');
      const isOpening = openCategory !== cat;
      
      catNav.querySelectorAll('.cat-toggle.active').forEach(b => {
        if (b.dataset.cat !== cat) {
          b.classList.remove('active');
          b.setAttribute('aria-expanded', 'false');
          const otherSub = catNav.querySelector('[data-submenu="' + b.dataset.cat + '"]');
          if (otherSub) otherSub.classList.remove('open');
        }
      });
      
      if (isOpening) {
        openCategory = cat;
        btn.classList.add('active');
        btn.setAttribute('aria-expanded', 'true');
        sub?.classList.add('open');
      } else {
        openCategory = null;
        btn.classList.remove('active');
        btn.setAttribute('aria-expanded', 'false');
        sub?.classList.remove('open');
        if (activeCat === cat) { activeCat = null; renderCatChips(); }
      }
    };
    frag.appendChild(btn);

    // Submenu (irmão direto do botão, no fluxo normal)
    const sub = document.createElement('div');
    sub.className = 'cat-submenu' + (isOpen ? ' open' : '');
    sub.dataset.submenu = cat;
    // Durante busca, categorias sem match mostram todos os produtos ao abrir
    const subItems = (searching && items.length === 0) 
      ? state.products.filter(p => p.active && p.category === cat)
      : items;
    sub.innerHTML = subItems.map(p => renderItem(p, q)).join('');
    sub.querySelectorAll('.item').forEach((el, j) => {
      el.style.setProperty('--d', Math.min(0.05 * j, 0.25) + 's');
    });
    frag.appendChild(sub);
  });

  catNav.appendChild(frag);

  // Liga cliques nos itens
  catNav.querySelectorAll('[data-open]').forEach(el => {
    el.onclick = (e) => {
      e.stopPropagation();
      openItemDetail(el.dataset.open);
    };
  });
  // Liga botões rápidos (+)
  catNav.querySelectorAll('[data-qadd]').forEach(el => {
    el.onclick = (e) => {
      e.stopPropagation();
      e.preventDefault();
      el.disabled = true;
      const id = el.dataset.qadd;
      const p = state.products.find(x => x.id === id);
      if (p && (p.variations && p.variations.length || p.extras && p.extras.length)) { openItemDetail(id); el.disabled = false; return; }
      addToCart(id, 1);
      el.disabled = false;
    };
  });
}

function categoryEmoji(cat) {
  const c = (cat||'').toLowerCase();
  if (c.includes('refri')) return '🥤';
  if (c.includes('suco'))  return '🧃';
  if (c.includes('água') || c.includes('agua')) return '💧';
  if (c.includes('cerveja')) return '🍺';
  if (c.includes('energ'))  return '⚡';
  if (c.includes('vinho'))  return '🍷';
  if (c.includes('destilad') || c.includes('cachaça') || c.includes('cachaca')) return '🥃';
  if (c.includes('combo'))  return '🧺';
  if (c.includes('petisco') || c.includes('salgado') || c.includes('snack')) return '🍢';
  if (c.includes('drink') || c.includes('cocktail')) return '🍹';
  if (c.includes('café') || c.includes('cafe')) return '☕';
  if (c.includes('chá') || c.includes('cha')) return '🍵';
  if (c.includes('leite')) return '🥛';
  return '🥤';
}

/* Paleta de fundo pastel do thumbnail — varia por categoria */
const THUMB_BG = [
  'linear-gradient(135deg,#ffe0e6,#ffd0d9)',
  'linear-gradient(135deg,#e0f7ee,#c6efe2)',
  'linear-gradient(135deg,#e6f0ff,#cfe2ff)',
  'linear-gradient(135deg,#fff4e0,#ffe3b3)',
  'linear-gradient(135deg,#f5e6ff,#e6ccff)',
  'linear-gradient(135deg,#e0f7fa,#c2ecf0)',
  'linear-gradient(135deg,#fee2e2,#fec9c9)',
  'linear-gradient(135deg,#fef9c3,#fde68a)',
  'linear-gradient(135deg,#ffedd5,#fed7aa)',
  'linear-gradient(135deg,#e7e5e4,#d6d3d1)'
];
function thumbBg(cat) {
  const s = (cat||'#').split('').reduce((a,c) => a + c.charCodeAt(0), 0);
  return THUMB_BG[s % THUMB_BG.length];
}

function renderBanner() {
  const bannerArea = $('bannerArea');
  if (!bannerArea) return;
  const banners = [];
  if (state.config.blockWhenClosed && !isStoreOpen()) {
    banners.push(`<div class="banner closed">🔒 <strong>Estamos fechados neste momento.</strong> Funcionamento: ${esc(state.config.hours || '—')}. O envio de pedidos é liberado no horário de funcionamento.</div>`);
  }
  bannerArea.classList.toggle('shape-round', state.config.bannerShape === 'round');
  bannerArea.classList.toggle('shape-square', state.config.bannerShape !== 'round');
  bannerArea.innerHTML = banners.join('');
  bannerArea.style.display = banners.length ? '' : 'none';
}

function renderMenu() {
  renderBanner();
  renderCats();
}

/**
 * Renderiza o card de um produto
 * @param {object} p Produto
 * @param {string} q Termo de busca para destacar (opcional)
 */
function renderItem(p, q = '') {
  const hasVar = p.variations && p.variations.length;
  const hasExtras = p.extras && p.extras.length;
  const basePrice = p.promo && p.promoPrice ? p.promoPrice : p.price;
  const out = p.stock <= 0;
  /* Variação é aditivo (+R$): o "a partir de" é o preço base mais o menor
     adicional, não o adicional sozinho. */
  const minDelta = hasVar ? Math.min(...p.variations.map(v => Number(v.price) || 0)) : 0;
  const displayPrice = basePrice + minDelta;
  const imgContent = p.image && (p.image.startsWith('http') || p.image.startsWith('data:') || p.image.startsWith('assets/'))
    ? `<img src="${esc(p.image)}" alt="${esc(p.name)}" onerror="this.parentElement.innerHTML='🥤'">`
    : esc(p.image || '🥤');
  const flag = p.highlight ? '<span class="flag">⭐ Top</span>' : (p.promo ? '<span class="flag promo">🔥 Promo</span>' : '');
  const canQuick = !hasVar && !hasExtras && !out;
  /* O preço aparece UMA vez so, na linha .item-price. O botao e apenas o "+". */
  const quickBtn = canQuick
    ? `<button class="quick-add" data-qadd="${p.id}" title="Adicionar ao carrinho" aria-label="Adicionar ${esc(p.name)} ao carrinho">+</button>`
    : (!out && (hasVar || hasExtras)
      ? `<button class="quick-add orange" data-qadd="${p.id}" title="Escolher opções" aria-label="Escolher opções de ${esc(p.name)}">+</button>`
      : '');
  return `
    <div class="item ${out ? 'out' : ''}" data-open="${p.id}" tabindex="0">
      <div class="item-thumb" style="background:${thumbBg(p.category)}">${imgContent}</div>
      <div class="item-body">
        ${flag}
        <div class="item-name">${highlight(p.name, q)}${out ? ' <span style="color:#6b7280;font-size:.75rem">(esgotado)</span>' : ''}</div>
        <div class="item-desc">${highlight(p.desc || '', q)}</div>
        <div class="item-foot">
          <div class="item-price">
            ${p.promo && p.promoPrice ? `<span class="old">${brl(p.price + minDelta)}</span>` : `<span style="font-size:.8rem">${hasVar ? 'a partir de ' : 'por '}</span>`}
            <span class="value">${brl(displayPrice)}</span>
          </div>
          ${quickBtn}
        </div>
      </div>
    </div>`;
}

function openItemDetail(id) {
  const p = state.products.find(x => x.id === id);
  if (!p) return;

  // Gate +18: produtos alcoólicos pedem confirmação (se habilitado nas regras)
  if (state.config.requireAge && !ageConfirmed() && isAlcoholic(p)) {
    $('sheetItem').innerHTML = `
      <div class="close-row"><h2>🔞 Conteúdo para maiores de 18</h2><button class="btn ghost" data-close>✕</button></div>
      <p class="subtitle">Este item é um <b>produto alcoólico</b>. Você confirma que tem <b>18 anos ou mais</b>?</p>
      <div class="modal-actions">
        <button class="btn ghost danger-text" id="ageNo">✕ Voltar</button>
        <button class="btn success" id="ageYes">✅ Sim, tenho 18+</button>
      </div>`;
    $('ageNo').onclick = closeAll;
    $('ageYes').onclick = () => { confirmAge(); openItemDetail(id); };
    $('overlayItem').classList.add('open');
    document.querySelectorAll('#sheetItem [data-close]').forEach(b => b.onclick = closeAll);
    return;
  }

  const basePrice = p.promo && p.promoPrice ? p.promoPrice : p.price;
  const out = p.stock <= 0;
  const imgContent = p.image && (p.image.startsWith('http') || p.image.startsWith('data:') || p.image.startsWith('assets/'))
    ? `<img class="detail-img" src="${esc(p.image)}" alt="${esc(p.name)}" onerror="this.outerHTML='<div class=\\'detail-emoji\\'>🥤</div>'">`
    : `<div class="detail-emoji">${esc(p.image||'🥤')}</div>`;

  let variationsHtml = '';
  if (p.variations && p.variations.length) {
    variationsHtml = `
      <div class="opt-group">
        <div class="gtitle">🧊 Escolha o tamanho <span class="req">Obrigatório</span></div>
        <div class="gsub">Selecione uma opção</div>
        ${p.variations.map((v,i) => `
          <label class="opt-item">
            <input type="radio" name="variation" value="${i}" ${i===0?'checked':''}>
            <span class="oname">${esc(v.name)}</span>
            <span class="oprice">${brl(basePrice + (Number(v.price) || 0))}</span>
          </label>`).join('')}
      </div>`;
  }

  let extrasHtml = '';
  if (p.extras && p.extras.length) {
    extrasHtml = `
      <div class="opt-group">
        <div class="gtitle">➕ Adicionais</div>
        <div class="gsub">Opcional — escolha quantos quiser</div>
        ${p.extras.map((e,i) => `
          <label class="opt-item">
            <input type="checkbox" class="extra-cb" data-idx="${i}">
            <span class="oname">${esc(e.name)}</span>
            <span class="oprice">${e.price ? '+ '+brl(e.price) : 'Grátis'}</span>
          </label>`).join('')}
      </div>`;
  }

  const rel = state.products
    .filter(r => r.active && r.id !== p.id && r.category === p.category && r.stock > 0)
    .slice(0, 4);
  const relatedHtml = rel.length ? `
    <div class="related">
      <div class="gtitle">📌 Quem viu este, também levou</div>
      <div class="related-grid">
        ${rel.map(r => {
          const emoji = r.image && (r.image.startsWith('http') || r.image.startsWith('data:') || r.image.startsWith('assets/')) ? '<span class="rel-emoji">🥤</span>' : `<span class="rel-emoji">${esc(r.image || '🥤')}</span>`;
          return `<button class="rel-card" data-rel="${esc(r.id)}">${emoji}<span class="rel-name">${esc(r.name)}</span><span class="rel-price">${brl(priceNow(r))}</span></button>`;
        }).join('')}
      </div>
    </div>` : '';

  $('sheetItem').innerHTML = `
    <div class="close-row"><h2>${esc(p.name)}</h2><button class="btn ghost" data-close>✕</button></div>
    ${imgContent}
    <p class="subtitle">${esc(p.desc||'')}</p>
    ${variationsHtml}
    ${extrasHtml}
    <div class="form-group">
      <label>Observação do item</label>
      <input type="text" id="itemObs" placeholder="Ex: sem gelo, bem gelada..." maxlength="100">
    </div>
    ${relatedHtml}
    <div class="qty" style="justify-content:center;padding:8px;margin:14px 0;position:relative">
      <button id="dQtyDec">−</button>
      <span id="dQty" style="font-size:1.1rem;min-width:40px">1</span>
      <button id="dQtyInc">+</button>
      <small style="position:absolute;right:8px;top:50%;transform:translateY(-50%);color:var(--muted);font-size:.75rem">${p.stock} em estoque</small>
    </div>
    <div class="modal-actions">
      <button class="btn ghost danger-text" id="dExit">✕ Sair</button>
      <button class="btn success" id="dAdd" ${out ? 'disabled' : ''}>
        ${out ? '❌ Esgotado' : '🛒 Adicionar'}
      </button>
    </div>`;

  let qty = 1;
  const calcPrice = () => {
    const varRadio = document.querySelector('input[name="variation"]:checked');
    const vAdd = varRadio ? (Number(p.variations[parseInt(varRadio.value)].price) || 0) : 0;
    let total = basePrice + vAdd;
    document.querySelectorAll('.extra-cb:checked').forEach(cb => {
      total += p.extras[parseInt(cb.dataset.idx)].price || 0;
    });
    return total;
  };
  const updPrice = () => {
    $('dAdd').textContent = out ? '❌ Esgotado' : `🛒 Adicionar — ${brl(calcPrice()*qty)}`;
  };
  document.querySelectorAll('input[name="variation"], .extra-cb').forEach(el => el.onchange = updPrice);
  $('dQtyInc').onclick = () => { if (qty < p.stock) { qty++; $('dQty').textContent = qty; updPrice(); } };
  $('dQtyDec').onclick = () => { if (qty > 1) { qty--; $('dQty').textContent = qty; updPrice(); } };
  updPrice();

  $('dAdd').onclick = () => {
    if (out) return;
    const varRadio = document.querySelector('input[name="variation"]:checked');
    const variation = varRadio ? p.variations[parseInt(varRadio.value)] : null;
    const extras = [...document.querySelectorAll('.extra-cb:checked')].map(cb => p.extras[parseInt(cb.dataset.idx)]);
    const obs = $('itemObs').value.trim();
    addToCart(p.id, qty, variation, extras, obs);
    closeAll(); openCart();
  };
  const dExit = $('dExit');
  if (dExit) dExit.onclick = closeAll;

  $('overlayItem').classList.add('open');
  document.querySelectorAll('#sheetItem [data-close]').forEach(b => b.onclick = closeAll);
  document.querySelectorAll('#sheetItem [data-rel]').forEach(btn => {
    btn.onclick = () => openItemDetail(btn.dataset.rel);
  });
}