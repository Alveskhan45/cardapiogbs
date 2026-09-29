/* =========================================================
   CLIENTES / ENTREGAS
========================================================= */

(function () {
  'use strict';

  const $ = (id) => document.getElementById(id);
  const KEY = 'bebidas_cardapio_v6';

  function money(v) {
    return (Number(v) || 0).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
  }

  function getOrders() {
    try { if (window.state && Array.isArray(window.state.orders)) return window.state.orders; } catch (e) {}
    try {
      const raw = localStorage.getItem(KEY);
      if (raw) {
        const p = JSON.parse(raw);
        if (p && Array.isArray(p.orders)) return p.orders;
      }
    } catch (e) {}
    return [];
  }

  function normStatus(s) {
    s = String(s || '').toLowerCase().trim();
    if (s === 'em entrega' || s === 'em_entrega') return 'entregando';
    if (s === 'concluido' || s === 'concluído' || s === 'finalizado') return 'entregue';
    if (s === 'cancelada') return 'cancelado';
    return s || 'pendente';
  }

  function normalize(o) {
    if (!o || typeof o !== 'object') return null;
    return {
      raw: o,
      id: o.id != null ? o.id : (o.numero != null ? o.numero : null),
      name: o.customer || o.cliente || o.name || o.nome || 'Cliente',
      tel: o.telefone || o.phone || '',
      total: Number(o.total != null ? o.total : (o.valor || 0)),
      status: normStatus(o.status || 'pendente'),
      createdAt: o.createdAt || o.created_at || o.data || o.timestamp || null,
      endereco: o.endereco || o.address || '',
      tipo: o.tipo || o.type || 'Entrega'
    };
  }

  /* ===================== CLIENTES ===================== */
  function renderClientes() {
    const orders = getOrders().map(normalize).filter(Boolean);
    const map = new Map();

    orders.forEach((o) => {
      const key = o.tel || o.name.toLowerCase();
      if (!map.has(key)) {
        map.set(key, { name: o.name, tel: o.tel, count: 0, total: 0, lastAt: null, lastId: null, lastStatus: '', address: o.endereco });
      }
      const c = map.get(key);
      c.count++;
      c.total += o.total;
      const t = o.createdAt ? new Date(o.createdAt).getTime() : 0;
      /* Guarda o pedido mais recente: é ele que o botão "Ver" abre. */
      if (c.lastId == null || t > (c.lastAt || 0)) {
        c.lastAt = t;
        c.lastId = o.id;
        c.lastStatus = o.status;
      }
      if (o.endereco) c.address = o.endereco;
    });

    const list = [...map.values()];
    const total = list.length;
    const fat = list.reduce((s, c) => s + c.total, 0);
    const rec = list.filter((c) => c.count > 1).length;
    const ticket = orders.length ? fat / orders.length : 0;

    if ($('clientesTotal')) $('clientesTotal').textContent = total;
    if ($('clientesFaturamento')) $('clientesFaturamento').textContent = money(fat);
    if ($('clientesRecorrentes')) $('clientesRecorrentes').textContent = rec;
    if ($('clientesTicket')) $('clientesTicket').textContent = money(ticket);

    const term = ($('clientesFilter')?.value || '').toLowerCase().trim();
    const order = $('clientesOrder')?.value || 'recent';

    let filtered = list.filter((c) => {
      if (!term) return true;
      return (c.name + ' ' + c.tel + ' ' + (c.address || '')).toLowerCase().includes(term);
    });

    if (order === 'orders') filtered.sort((a, b) => b.count - a.count);
    else if (order === 'value') filtered.sort((a, b) => b.total - a.total);
    else if (order === 'name') filtered.sort((a, b) => a.name.localeCompare(b.name));
    else filtered.sort((a, b) => (b.lastAt || 0) - (a.lastAt || 0));

    const tbody = $('tblClientes');
    if (!tbody) return;
    if (!filtered.length) {
      tbody.innerHTML = '<tr><td colspan="6" style="text-align:center;color:var(--muted);padding:24px">Nenhum cliente ainda</td></tr>';
      return;
    }
    tbody.innerHTML = filtered.map((c, i) => `
      <tr>
        <td><b>${esc(c.name)}</b></td>
        <td>${esc(c.tel || '—')}</td>
        <td>${c.count}</td>
        <td>${money(c.total)}</td>
        <td>${c.lastAt ? new Date(c.lastAt).toLocaleDateString('pt-BR') : '—'}</td>
        <td style="white-space:nowrap">
          ${c.lastId != null ? `<button class="btn sm primary" data-cli-view="${i}" title="Ver último pedido">👁 Ver</button>` : ''}
          <button class="btn sm info" data-cli-wa="${i}" title="WhatsApp">📱</button>
        </td>
      </tr>
    `).join('');

    tbody.querySelectorAll('[data-cli-view]').forEach((b) => {
      b.onclick = () => {
        const c = filtered[Number(b.getAttribute('data-cli-view'))];
        if (c && c.lastId != null && typeof openOrderDetail === 'function') openOrderDetail(c.lastId);
      };
    });
    tbody.querySelectorAll('[data-cli-wa]').forEach((b) => {
      b.onclick = () => {
        const c = filtered[Number(b.getAttribute('data-cli-wa'))];
        if (!c) return;
        const cfg = (typeof state !== 'undefined' && state.config) ? state.config : {};
        let m = `Olá ${c.name}, tudo bem? Aqui é da ${(cfg.storeName || 'nossa loja')}.`;
        if (c.lastId != null) m += `\nVi que seu último pedido foi o #${c.lastId}. Como podemos ajudar?`;
        const numero = c.tel ? String(c.tel).replace(/\D/g, '') : String(cfg.whatsapp || '').replace(/\D/g, '');
        window.open(`https://wa.me/${numero}?text=${encodeURIComponent(m)}`, '_blank');
      };
    });
  }

  /* ===================== ENTREGAS ===================== */
  function renderEntregas() {
    const orders = getOrders().map(normalize).filter(Boolean);
    const aguardando = orders.filter((o) => o.status === 'preparando' || o.status === 'pendente');
    const emEntrega  = orders.filter((o) => o.status === 'entregando');
    const entregues  = orders.filter((o) => o.status === 'entregue');

    if ($('entregasAguardando')) $('entregasAguardando').textContent = aguardando.length;
    if ($('entregasEmEntrega')) $('entregasEmEntrega').textContent = emEntrega.length;
    if ($('entregasFinalizadas')) $('entregasFinalizadas').textContent = entregues.length;
    if ($('entregasTotal')) $('entregasTotal').textContent = aguardando.length + emEntrega.length + entregues.length;

    const term = ($('entregasFilter')?.value || '').toLowerCase().trim();
    const statusF = $('entregasStatusFilter')?.value || '';

    let list = orders.filter((o) => {
      if (statusF === 'pronto' && !(o.status === 'preparando' || o.status === 'pendente')) return false;
      if (statusF === 'entregando' && o.status !== 'entregando') return false;
      if (statusF === 'entregue' && o.status !== 'entregue') return false;
      if (term) {
        const hay = (String(o.id) + ' ' + o.name + ' ' + o.tel).toLowerCase();
        if (!hay.includes(term)) return false;
      }
      return true;
    });

    const tbody = $('tblEntregas');
    if (!tbody) return;
    if (!list.length) {
      tbody.innerHTML = '<tr><td colspan="7" style="text-align:center;color:var(--muted);padding:24px">Nenhuma entrega</td></tr>';
      return;
    }

    tbody.innerHTML = list.map((o) => {
      const stLabel = o.status === 'entregando' ? '🟣 Em entrega' :
                      o.status === 'entregue' ? '🟢 Entregue' : '🟡 Aguardando';
      const acao = o.status === 'entregando'
        ? `<button class="btn sm success" data-finaliza="${esc(o.id)}">✅ Concluir</button>`
        : o.status === 'entregue'
        ? '—'
        : `<button class="btn sm primary" data-envia="${esc(o.id)}">🛵 Enviar</button>`;
      return `
        <tr>
          <td>#${esc(o.id)}</td>
          <td>${esc(o.name)}</td>
          <td>${esc(o.endereco || '—')}</td>
          <td>${esc(o.tel || '—')}</td>
          <td>${money(o.total)}</td>
          <td>${stLabel}</td>
          <td>${acao}</td>
        </tr>
      `;
    }).join('');

    tbody.querySelectorAll('[data-envia]').forEach((b) => {
      b.addEventListener('click', () => {
        const id = b.getAttribute('data-envia');
        if (typeof window.changeOrderStatus === 'function') window.changeOrderStatus(id, 'entregando');
        window.dispatchEvent(new CustomEvent('orders:updated'));
        renderEntregas();
      });
    });
    tbody.querySelectorAll('[data-finaliza]').forEach((b) => {
      b.addEventListener('click', () => {
        const id = b.getAttribute('data-finaliza');
        if (typeof window.changeOrderStatus === 'function') window.changeOrderStatus(id, 'entregue');
        window.dispatchEvent(new CustomEvent('orders:updated'));
        renderEntregas();
      });
    });
  }

  /* ===================== HOOKS ===================== */
  function init() {
    ['clientesFilter','clientesOrder'].forEach((id) => {
      const el = $(id);
      if (!el) return;
      el.addEventListener('input', renderClientes);
      el.addEventListener('change', renderClientes);
    });
    ['entregasFilter','entregasStatusFilter'].forEach((id) => {
      const el = $(id);
      if (!el) return;
      el.addEventListener('input', renderEntregas);
      el.addEventListener('change', renderEntregas);
    });
    $('btnAtualizarClientes')?.addEventListener('click', renderClientes);
    $('btnAtualizarEntregas')?.addEventListener('click', renderEntregas);

    document.querySelectorAll('.sb-item[data-tab]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const tab = btn.getAttribute('data-tab');
        setTimeout(() => {
          if (tab === 'clientes') renderClientes();
          if (tab === 'entregas') renderEntregas();
        }, 100);
      });
    });

    renderClientes();
    renderEntregas();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => setTimeout(init, 100));
  } else {
    setTimeout(init, 100);
  }

  window.AdminMelhorias = { renderClientes, renderEntregas };
})();