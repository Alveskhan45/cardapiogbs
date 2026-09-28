/* ==================== DASHBOARD ==================== */
function renderDashboard() {
  const valid = state.orders.filter(o => o.status !== 'cancelado');

  // KPI: Vendas hoje
  const today = localDay(Date.now());
  const todayOrders = valid.filter(o => localDay(o.createdAt || Date.now()) === today);
  const todayTotal = todayOrders.reduce((s,o) => s + o.total, 0);
  const el1 = $('kpiHoje'); if (el1) el1.textContent = brl(todayTotal);
  const el1s = $('kpiHojeSub'); if (el1s) el1s.textContent = todayOrders.length + ' pedido' + (todayOrders.length===1?'':'s');

  // KPI: Pendentes
  const pending = state.orders.filter(o => o.status === 'pendente').length;
  const el2 = $('kpiPend'); if (el2) el2.textContent = pending;
  const el2s = $('kpiPendSub'); if (el2s) el2s.textContent = pending > 0 ? 'aguardando' : 'tudo em ordem';

  // KPI: Estoque baixo
  const low = state.products.filter(p => p.active && p.stock <= state.config.minStock).length;
  const el3 = $('kpiLow'); if (el3) el3.textContent = low;
  const kpiLowCard = el3 ? el3.closest('.kpi') : null;
  if (kpiLowCard) kpiLowCard.classList.toggle('danger', low > 0);

  // KPI: Produtos
  const active = state.products.filter(p => p.active).length;
  const el4 = $('kpiProd'); if (el4) el4.textContent = active;
  const el4s = $('kpiProdSub'); if (el4s) el4s.textContent = state.categories.length + ' categoria' + (state.categories.length===1?'':'s');

  // Badges da sidebar
  const sbProd = $('sbBadgeProd'); if (sbProd) sbProd.textContent = state.products.length;
  const sbPed = $('sbBadgePed'); if (sbPed) sbPed.textContent = pending;

  // Gráfico
  renderChart();

  // Top produtos
  const counts = {};
  valid.forEach(o => o.items.forEach(i => counts[i.name] = (counts[i.name]||0) + i.qty));
  const top = Object.entries(counts).sort((a,b)=>b[1]-a[1]).slice(0,5);
  const elTop = $('dashTop');
  if (elTop) {
    elTop.innerHTML = top.length
      ? top.map(([n,q],i) => `
          <div class="dash-item">
            <span><b>${i+1}º</b> ${n}</span>
            <b>${q} un</b>
          </div>`).join('')
      : '<div class="dash-empty">Sem vendas ainda</div>';
  }

  // Alertas de estoque
  const alertas = state.products
    .filter(p => p.active && p.stock <= state.config.minStock)
    .sort((a,b) => a.stock - b.stock)
    .slice(0,5);
  const elAl = $('dashAlertas');
  if (elAl) {
    elAl.innerHTML = alertas.length
      ? alertas.map(p => `
          <div class="dash-item">
            <span>${p.image && (p.image.startsWith('http')||p.image.startsWith('assets/')) ? '📷' : (p.image||'🥤')} ${p.name}</span>
            <b style="color:${p.stock===0?'var(--danger)':'var(--warning)'}">${p.stock === 0 ? 'esgotado' : p.stock + ' un'}</b>
          </div>`).join('')
      : '<div class="dash-empty">✅ Estoque em dia</div>';
  }

  // Últimos pedidos
  const recent = state.orders.slice(0, 5);
  const elRec = $('dashUltimos');
  if (elRec) {
    elRec.innerHTML = recent.length
      ? recent.map(o => `
          <div class="dash-item">
            <span>#${o.id} — ${o.customer}</span>
            <b>${brl(o.total)}</b>
          </div>`).join('')
      : '<div class="dash-empty">Sem pedidos</div>';
  }

  // Botões "ver tudo"
  const b1 = $('dashGoEstoque'); if (b1) b1.onclick = () => switchAdminTab('estoque');
  const b2 = $('dashGoPed'); if (b2) b2.onclick = () => switchAdminTab('ped');
}

function renderChart() {
  const el = $('chartVendas');
  if (!el) return;

  // Últimos 7 dias
  const days = [];
  for (let i = 6; i >= 0; i--) {
    const d = new Date();
    d.setDate(d.getDate() - i);
    days.push({
      iso: localDay(d),
      label: d.toLocaleDateString('pt-BR', { weekday: 'short' }).slice(0,3)
    });
  }

  const valid = state.orders.filter(o => o.status !== 'cancelado');
  const totals = days.map(d => {
    return valid
      .filter(o => localDay(o.createdAt || Date.now()) === d.iso)
      .reduce((s,o) => s + o.total, 0);
  });
  const max = Math.max(...totals, 1);
  const sum = totals.reduce((a,b) => a+b, 0);

  const tag = $('dashTotal7');
  if (tag) tag.textContent = brl(sum);

  // Estado vazio
  if (sum <= 0) {
    el.innerHTML = '<div class="chart-empty">Sem vendas nos últimos 7 dias 📉</div>';
  } else {
    el.innerHTML = totals.map((v, i) => {
      const h = Math.max(4, (v / max) * 100);
      return `<div class="chart-bar" style="height:${h}%" title="${brl(v)}">
        <span class="cval">${brl(v)}</span>
      </div>`;
    }).join('');
  }

  // Labels
  let labelsEl = el.nextElementSibling;
  if (!labelsEl || !labelsEl.classList.contains('chart-labels')) {
    labelsEl = document.createElement('div');
    labelsEl.className = 'chart-labels';
    el.parentElement.appendChild(labelsEl);
  }
  labelsEl.innerHTML = days.map(d => `<span>${d.label}</span>`).join('');
}