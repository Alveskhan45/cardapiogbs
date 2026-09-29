/* ==================== PEDIDOS (visualização detalhada) ==================== */

/* Fonte única de mudança de status — detalhe do pedido, kanban, lista e os
   botões da aba Entregas. Antes cada tela fazia o seu e a aba Entregas chamava
   window.changeOrderStatus, que não existia: o botão mostrava sucesso e o
   status não mudava. */
function changeOrderStatus(orderId, newStatus) {
  const ord = state.orders.find(x => String(x.id) === String(orderId));
  if (!ord) { toast('⚠️ Pedido não encontrado'); return false; }
  if (ord.status === newStatus) return true;
  const at = new Date().toISOString();
  const prevStatus = ord.status || 'pendente';
  ord.status = newStatus;
  ord.statusUpdatedAt = at;
  /* Linha do tempo mostrada no "Acompanhar pedido". Mesmo formato que o
     servidor grava (server.js → mergeStatusHistory). */
  if (!Array.isArray(ord.statusHistory) || !ord.statusHistory.length) {
    ord.statusHistory = [{ status: prevStatus, at: ord.createdAt || at }];
  }
  if (ord.statusHistory[ord.statusHistory.length - 1].status !== newStatus) {
    ord.statusHistory.push({ status: newStatus, at });
  }
  save();
  logActivity('🔄', `Pedido #${ord.id} → ${newStatus}`);
  toast(`✅ Status atualizado para "${newStatus}"`);
  if (typeof renderAdminOrders === 'function') renderAdminOrders();
  if (typeof renderDashboard === 'function') renderDashboard();
  if (window.AdminMelhorias) {
    if (typeof window.AdminMelhorias.renderEntregas === 'function') window.AdminMelhorias.renderEntregas();
    if (typeof window.AdminMelhorias.renderClientes === 'function') window.AdminMelhorias.renderClientes();
  }
  try { window.dispatchEvent(new CustomEvent('orders:updated')); } catch (e) {}
  return true;
}
window.changeOrderStatus = changeOrderStatus;

function openOrderDetail(orderId) {
  const o = state.orders.find(x => String(x.id) === String(orderId));
  if (!o) return;

  const statusList = ['pendente','preparando','entregando','entregue','cancelado'];

  $('sheetOrderDetail').innerHTML = `
    <div class="close-row">
      <h2>Pedido #${o.id}</h2>
      <button class="btn ghost" data-close>✕</button>
    </div>
    <div style="display:grid;gap:8px;font-size:.9rem;margin-bottom:16px">
      <div><b>Cliente:</b> ${esc(o.customer)}</div>
      ${o.phone ? `<div><b>Telefone:</b> ${esc(o.phone)}</div>` : ''}
      <div><b>Tipo:</b> ${esc(o.type)}</div>
      ${o.address ? `<div><b>Endereço:</b> ${esc(o.address)}</div>` : ''}
      ${o.bairro ? `<div><b>Bairro:</b> ${esc(o.bairro)}</div>` : ''}
      ${o.km ? `<div><b>Distância:</b> ${esc(o.km)} km</div>` : ''}
      <div><b>Pagamento:</b> ${esc(o.payment)}</div>
      ${o.change ? `<div><b>Troco para:</b> ${esc(o.change)}</div>` : ''}
      ${o.notes ? `<div><b>Observação:</b> ${esc(o.notes)}</div>` : ''}
      <div><b>Data:</b> ${fmtDateTime(o.createdAt)}</div>
    </div>

    <h3 style="font-size:.95rem;margin-bottom:8px">Itens</h3>
    <table style="width:100%;font-size:.85rem;margin-bottom:14px">
      <thead><tr><th>Qtd</th><th>Produto</th><th style="text-align:right">Total</th></tr></thead>
      <tbody>
        ${o.items.map(i => `
          <tr>
            <td>${i.qty}x</td>
            <td>${esc(i.name)}
              ${i.variation ? `<br><small style="color:var(--muted)">${esc(i.variation)}</small>` : ''}
              ${i.extras && i.extras.length ? `<br><small style="color:var(--muted)">+ ${esc(i.extras.join(', '))}</small>` : ''}
              ${i.obs ? `<br><small style="color:var(--info);font-style:italic">📝 ${esc(i.obs)}</small>` : ''}
            </td>
            <td style="text-align:right">${brl(i.total)}</td>
          </tr>`).join('')}
      </tbody>
    </table>

    <div class="summary">
      <div class="row"><span>Subtotal</span><span>${brl(o.subtotal)}</span></div>
      ${o.discount ? `<div class="row" style="color:var(--success)"><span>Desconto${o.coupon ? ' ('+esc(o.coupon)+')' : ''}</span><span>− ${brl(o.discount)}</span></div>` : ''}
      <div class="row"><span>Frete</span><span>${brl(o.delivery||0)}</span></div>
      <div class="row tot"><span>Total</span><span>${brl(o.total)}</span></div>
    </div>

    <h3 style="font-size:.95rem;margin:14px 0 8px">Atualizar status</h3>
    <div style="display:flex;gap:6px;flex-wrap:wrap;margin-bottom:16px">
      ${statusList.map(s => `
        <button class="btn sm ${o.status===s ? 'primary' : 'ghost'}" data-setstatus="${s}" data-oid="${o.id}">
          ${s}
        </button>`).join('')}
    </div>

    <button class="btn info full" id="orderPrint" data-oid="${o.id}" style="margin-bottom:8px">🖨️ Imprimir comprovante</button>
    <button class="btn success full" id="orderWhats" data-oid="${o.id}">📱 Responder no WhatsApp</button>
  `;

  $('sheetOrderDetail').querySelectorAll('[data-close]').forEach(b => b.onclick = closeAll);
  $('sheetOrderDetail').querySelectorAll('[data-setstatus]').forEach(b => {
    b.onclick = () => {
      if (changeOrderStatus(b.dataset.oid, b.dataset.setstatus)) openOrderDetail(orderId);
    };
  });
  const btnWpp = $('orderWhats');
  if (btnWpp) btnWpp.onclick = () => {
    const ord = state.orders.find(x => String(x.id) === String(btnWpp.dataset.oid));
    if (!ord) return;
    let m = `Olá ${ord.customer}, seu pedido #${ord.id} está com status: *${ord.status}*.\nTotal: ${brl(ord.total)}`;
    window.open(`https://wa.me/${ord.phone ? ord.phone.replace(/\D/g,'') : state.config.whatsapp}?text=${encodeURIComponent(m)}`, '_blank');
  };

  const btnPrint = $('orderPrint');
  if (btnPrint) btnPrint.onclick = () => {
    const ord = state.orders.find(x => String(x.id) === String(btnPrint.dataset.oid));
    if (ord) printOrderReceipt(ord);
  };

  $('overlayOrderDetail').classList.add('open');
}

function printOrderReceipt(o) {
  const cfg = state.config;
  const w = window.open('', '_blank', 'width=420,height=600');
  if (!w) { toast('Permita pop-ups para imprimir'); return; }
  const itemsHtml = o.items.map(i =>
    `<div>${i.qty}x ${esc(i.name)}${i.variation ? ' (' + esc(i.variation) + ')' : ''}${i.extras && i.extras.length ? ' + ' + esc(i.extras.join(', ')) : ''}${i.obs ? ' <i>[📝 ' + esc(i.obs) + ']</i>' : ''} = ${brl(i.total)}</div>`
  ).join('');
  w.document.write(`<!doctype html><html lang="pt-BR"><head><meta charset="utf-8">
<title>Comprovante #${o.id}</title>
<style>
  body{font-family:'Courier New',monospace;font-size:13px;width:320px;margin:0 auto;padding:16px 8px;color:#000}
  h1{font-size:15px;margin:0 0 2px;text-align:center}
  .center{text-align:center}
  hr{border:none;border-top:1px dashed #000;margin:8px 0}
  .row{display:flex;justify-content:space-between;gap:8px}
  .tot{font-weight:bold;font-size:15px}
  .items div{margin:3px 0}
  .muted{color:#444}
  @media print{body{width:auto;padding:0}}
</style></head><body>
  <h1>${esc(cfg.storeName || 'Cardápio Digital')}</h1>
  <div class="center muted">${esc(cfg.address || '')}</div>
  <div class="center muted">${esc(cfg.phone || '')}</div>
  <hr>
  <div><b>PEDIDO #${esc(o.id)}</b> <span class="muted">${esc(o.trackCode || '')}</span></div>
  <div class="muted">${fmtDateTime(o.createdAt)}</div>
  <div>Cliente: ${esc(o.customer)}</div>
  ${o.phone ? '<div>Tel: ' + esc(o.phone) + '</div>' : ''}
  <div>${esc(o.type)}</div>
  ${o.address ? '<div>' + esc(o.address) + '</div>' : ''}
  ${o.bairro ? '<div>Bairro: ' + esc(o.bairro) + '</div>' : ''}
  ${o.km ? '<div>Distância: ' + esc(o.km) + ' km</div>' : ''}
  <hr>
  <div class="items">${itemsHtml}</div>
  <hr>
  <div class="row"><span>Subtotal</span><span>${brl(o.subtotal)}</span></div>
  ${o.discount ? '<div class="row"><span>Desconto' + (o.coupon ? ' (' + esc(o.coupon) + ')' : '') + '</span><span>- ' + brl(o.discount) + '</span></div>' : ''}
  <div class="row"><span>Frete</span><span>${brl(o.delivery || 0)}</span></div>
  ${o.freeFreight ? '<div class="row"><span>Cupom frete grátis</span></div>' : ''}
  <div class="row"><span>Pagamento: ${esc(o.payment || '—')}</span></div>
  ${o.change ? '<div class="row"><span>Troco para: ' + esc(o.change) + '</span></div>' : ''}
  <hr>
  <div class="row tot"><span>TOTAL</span><span>${brl(o.total)}</span></div>
  ${o.notes ? '<div class="muted">Obs: ' + esc(o.notes) + '</div>' : ''}
  <hr>
  <div class="center">Obrigado pela preferência!</div>
</body></html>`);
  w.document.close();
  setTimeout(() => { try { w.focus(); w.print(); } catch (e) {} }, 300);
}