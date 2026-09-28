/* ==================== PEDIDOS (visualização detalhada) ==================== */
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
      <div><b>Cliente:</b> ${o.customer}</div>
      ${o.phone ? `<div><b>Telefone:</b> ${o.phone}</div>` : ''}
      <div><b>Tipo:</b> ${o.type}</div>
      ${o.address ? `<div><b>Endereço:</b> ${o.address}</div>` : ''}
      ${o.bairro ? `<div><b>Bairro:</b> ${o.bairro}</div>` : ''}
      ${o.km ? `<div><b>Distância:</b> ${o.km} km</div>` : ''}
      <div><b>Pagamento:</b> ${o.payment}</div>
      ${o.change ? `<div><b>Troco para:</b> ${o.change}</div>` : ''}
      ${o.notes ? `<div><b>Observação:</b> ${o.notes}</div>` : ''}
      <div><b>Data:</b> ${fmtDateTime(o.createdAt)}</div>
    </div>

    <h3 style="font-size:.95rem;margin-bottom:8px">Itens</h3>
    <table style="width:100%;font-size:.85rem;margin-bottom:14px">
      <thead><tr><th>Qtd</th><th>Produto</th><th style="text-align:right">Total</th></tr></thead>
      <tbody>
        ${o.items.map(i => `
          <tr>
            <td>${i.qty}x</td>
            <td>${i.name}
              ${i.variation ? `<br><small style="color:var(--muted)">${i.variation}</small>` : ''}
              ${i.extras && i.extras.length ? `<br><small style="color:var(--muted)">+ ${i.extras.join(', ')}</small>` : ''}
              ${i.obs ? `<br><small style="color:var(--info);font-style:italic">📝 ${i.obs}</small>` : ''}
            </td>
            <td style="text-align:right">${brl(i.total)}</td>
          </tr>`).join('')}
      </tbody>
    </table>

    <div class="summary">
      <div class="row"><span>Subtotal</span><span>${brl(o.subtotal)}</span></div>
      ${o.discount ? `<div class="row" style="color:var(--success)"><span>Desconto${o.coupon ? ' ('+o.coupon+')' : ''}</span><span>− ${brl(o.discount)}</span></div>` : ''}
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
      const ord = state.orders.find(x => String(x.id) === String(b.dataset.oid));
      if (ord) {
        ord.status = b.dataset.setstatus;
        ord.statusUpdatedAt = new Date().toISOString();
        save();
        logActivity('🔄', `Pedido #${ord.id} → ${b.dataset.setstatus}`);
        toast(`✅ Status atualizado para "${b.dataset.setstatus}"`);
        renderAdminOrders();
        renderDashboard();
        openOrderDetail(orderId);
      }
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
    `<div>${i.qty}x ${i.name}${i.variation ? ' (' + i.variation + ')' : ''}${i.extras && i.extras.length ? ' + ' + i.extras.join(', ') : ''}${i.obs ? ' <i>[📝 ' + i.obs + ']</i>' : ''} = ${brl(i.total)}</div>`
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
  <h1>${cfg.storeName || 'Cardápio Digital'}</h1>
  <div class="center muted">${cfg.address || ''}</div>
  <div class="center muted">${cfg.phone || ''}</div>
  <hr>
  <div><b>PEDIDO #${o.id}</b> <span class="muted">${o.trackCode || ''}</span></div>
  <div class="muted">${fmtDateTime(o.createdAt)}</div>
  <div>Cliente: ${o.customer}</div>
  ${o.phone ? '<div>Tel: ' + o.phone + '</div>' : ''}
  <div>${o.type}</div>
  ${o.address ? '<div>' + o.address + '</div>' : ''}
  ${o.bairro ? '<div>Bairro: ' + o.bairro + '</div>' : ''}
  ${o.km ? '<div>Distância: ' + o.km + ' km</div>' : ''}
  <hr>
  <div class="items">${itemsHtml}</div>
  <hr>
  <div class="row"><span>Subtotal</span><span>${brl(o.subtotal)}</span></div>
  ${o.discount ? '<div class="row"><span>Desconto' + (o.coupon ? ' (' + o.coupon + ')' : '') + '</span><span>- ' + brl(o.discount) + '</span></div>' : ''}
  <div class="row"><span>Frete</span><span>${brl(o.delivery || 0)}</span></div>
  ${o.freeFreight ? '<div class="row"><span>Cupom frete grátis</span></div>' : ''}
  <div class="row"><span>Pagamento: ${o.payment || '—'}</span></div>
  ${o.change ? '<div class="row"><span>Troco para: ' + o.change + '</span></div>' : ''}
  <hr>
  <div class="row tot"><span>TOTAL</span><span>${brl(o.total)}</span></div>
  ${o.notes ? '<div class="muted">Obs: ' + o.notes + '</div>' : ''}
  <hr>
  <div class="center">Obrigado pela preferência!</div>
</body></html>`);
  w.document.close();
  setTimeout(() => { try { w.focus(); w.print(); } catch (e) {} }, 300);
}