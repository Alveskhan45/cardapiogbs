/* =========================================================
   ALTERNÂNCIA DE VISÃO NA ABA PEDIDOS (LISTA / KANBAN)
   ---------------------------------------------------------
   - Não mexe em abas, não simula clique
   - Chama window.changeOrderStatus se existir
   - Dispara 'orders:updated' para a tabela se atualizar
   ========================================================= */

(function () {
  'use strict';

  const STORAGE_KEY = 'bebidas_cardapio_v6_ped_view';
  const STATE_KEY   = 'bebidas_cardapio_v6';
  const VALID_VIEWS = ['list', 'kanban'];
  const STATUSES = ['pendente', 'preparando', 'entregando', 'entregue', 'cancelado'];

  let currentView = 'list';

  function money(v) {
    return (Number(v) || 0).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
  }

  function esc(s) {
    if (s == null) return '';
    return String(s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#039;');
  }

  function timeAgo(ts) {
    if (!ts) return '';
    const t = new Date(ts).getTime();
    if (isNaN(t)) return '';
    const diff = Date.now() - t;
    const min = Math.floor(diff / 60000);
    if (min < 1) return 'agora';
    if (min < 60) return min + ' min';
    const h = Math.floor(min / 60);
    if (h < 24) return h + ' h';
    return Math.floor(h / 24) + ' d';
  }

  function cap(s) { return s.charAt(0).toUpperCase() + s.slice(1); }

  function normStatus(s) {
    s = String(s || '').toLowerCase().trim();
    if (s === 'em entrega' || s === 'em_entrega') return 'entregando';
    if (s === 'concluido' || s === 'concluído' || s === 'finalizado') return 'entregue';
    if (s === 'cancelada') return 'cancelado';
    return s || 'pendente';
  }

  function getOrders() {
    let fromLS = null, fromState = null;
    try {
      const raw = localStorage.getItem(STATE_KEY);
      if (raw) {
        const p = JSON.parse(raw);
        if (p && Array.isArray(p.orders)) fromLS = p.orders;
      }
    } catch (e) {}
    try {
      if (window.state && Array.isArray(window.state.orders)) fromState = window.state.orders;
    } catch (e) {}
    if (fromLS && fromState) return fromLS.length >= fromState.length ? fromLS : fromState;
    return fromLS || fromState || [];
  }

  function normalizeOrder(o) {
    if (!o || typeof o !== 'object') return null;
    const rawId = o.id != null ? o.id : o.numero != null ? o.numero : o.num != null ? o.num : null;
    const id = rawId != null ? '#' + String(rawId).replace(/^#/, '') : '#—';
    const name = o.cliente || o.name || o.nome || o.customer || 'Cliente';
    const total = o.total != null ? o.total : (o.valor != null ? o.valor : 0);
    const pay = o.pagamento || o.pay || o.payment || o.formaPagamento || '—';
    const status = normStatus(o.status || 'pendente');
    const createdAt = o.createdAt || o.created_at || o.data || o.timestamp || null;
    const items = Array.isArray(o.items) ? o.items : Array.isArray(o.itens) ? o.itens : [];
    const itemsText = items.length
      ? items.map((it) => {
          const q = it.qty != null ? it.qty : it.quantidade != null ? it.quantidade : 1;
          const n = it.name || it.nome || it.produto || 'Item';
          return q + '× ' + n;
        }).join(', ')
      : 'Sem itens';
    return { id, rawId: rawId != null ? rawId : id, name, total, pay, status, createdAt, itemsText, raw: o };
  }

  function applyFilters(list) {
    const term = (document.getElementById('pedFilter')?.value || '').trim().toLowerCase();
    const status = document.getElementById('pedStatusFilter')?.value || '';
    const period = document.getElementById('pedPeriodFilter')?.value || '';
    const now = Date.now();
    const dayMs = 86400000;

    return list.filter((o) => {
      const n = normalizeOrder(o);
      if (!n) return false;
      if (term) {
        const tel = n.raw.telefone || n.raw.phone || '';
        if (!(n.id + ' ' + n.name + ' ' + tel).toLowerCase().includes(term)) return false;
      }
      if (status && n.status !== status) return false;
      if (period && n.createdAt) {
        const t = new Date(n.createdAt).getTime();
        if (!isNaN(t)) {
          if (period === 'today') {
            const d = new Date(); d.setHours(0,0,0,0);
            if (t < d.getTime()) return false;
          } else if (period === '7d' && now - t > 7 * dayMs) return false;
          else if (period === '30d' && now - t > 30 * dayMs) return false;
        }
      }
      return true;
    });
  }

  function changeStatus(rawId, newStatus) {
    if (typeof window.changeOrderStatus === 'function') {
      try {
        window.changeOrderStatus(rawId, newStatus);
        try { window.dispatchEvent(new CustomEvent('orders:updated')); } catch (e) {}
        return true;
      } catch (e) {}
    }

    let updated = false;
    try {
      const raw = localStorage.getItem(STATE_KEY);
      if (raw) {
        const parsed = JSON.parse(raw);
        if (parsed && Array.isArray(parsed.orders)) {
          const found = parsed.orders.find(
            (o) => String(o.id) === String(rawId) || String(o.numero) === String(rawId)
          );
          if (found) {
            found.status = newStatus;
            found.updatedAt = new Date().toISOString();
            localStorage.setItem(STATE_KEY, JSON.stringify(parsed));
            updated = true;
          }
        }
      }
    } catch (e) {}

    try {
      if (window.state && Array.isArray(window.state.orders)) {
        const f = window.state.orders.find(
          (o) => String(o.id) === String(rawId) || String(o.numero) === String(rawId)
        );
        if (f) { f.status = newStatus; f.updatedAt = new Date().toISOString(); updated = true; }
      }
    } catch (e) {}

    if (!updated) return false;
    try { if (typeof window.save === 'function') window.save(); } catch (e) {}
    try { window.dispatchEvent(new CustomEvent('orders:updated')); } catch (e) {}
    return true;
  }

  function updateKpis() {
    const counts = { pendente: 0, preparando: 0, entregando: 0, entregue: 0 };
    getOrders().forEach((o) => {
      const st = normStatus(o.status);
      if (counts[st] !== undefined) counts[st]++;
    });
    const map = { cntPend: 'pendente', cntPrep: 'preparando', cntEntr: 'entregando', cntFim: 'entregue' };
    for (const id in map) {
      const el = document.getElementById(id);
      if (el) el.textContent = counts[map[id]];
    }
  }

  function renderKanban() {
    const all = applyFilters(getOrders());
    const normalized = all.map(normalizeOrder).filter(Boolean);

    STATUSES.forEach((st) => {
      const body = document.getElementById('kanban' + cap(st));
      const countEl = document.getElementById('kanbanCount' + cap(st));
      if (!body) return;
      const items = normalized.filter((n) => n.status === st);
      if (countEl) countEl.textContent = items.length;
      if (!items.length) {
        body.innerHTML = '<div class="kanban-empty">Nenhum pedido</div>';
        return;
      }
      body.innerHTML = items.map(cardHtml).join('');
    });

    updateKpis();
    bindKanbanEvents();
  }

  function cardHtml(n) {
    const canCancel = n.status !== 'entregue' && n.status !== 'cancelado';
    const next = nextStatus(n.status);
    const prev = prevStatus(n.status);
    const nextLabel = next ? nextLabelFor(next) : null;
    return `
      <div class="kanban-card" draggable="true"
           data-id="${esc(n.rawId)}" data-status="${esc(n.status)}">
        <div class="kanban-card-top">
          <span class="kanban-card-id">${esc(n.id)}</span>
          <span class="kanban-card-time">${esc(timeAgo(n.createdAt))}</span>
        </div>
        <h5 class="kanban-card-name">${esc(n.name)}</h5>
        <div class="kanban-card-items">${esc(n.itemsText)}</div>
        <div class="kanban-card-foot">
          <span class="kanban-card-total">${esc(money(n.total))}</span>
          <span class="kanban-card-pay">${esc(n.pay)}</span>
        </div>
        <div class="kanban-card-actions">
          <div class="kanban-card-nav">
            ${prev ? `<button class="btn sm ghost" data-action="back"
               data-id="${esc(n.rawId)}" data-prev="${prev}">⬅ Voltar</button>` : ''}
            ${next ? `<button class="btn sm primary" data-action="advance"
               data-id="${esc(n.rawId)}" data-next="${next}">${nextLabel}</button>` : ''}
          </div>
          ${canCancel ? `<button class="btn sm ghost full danger-text" data-action="cancel"
             data-id="${esc(n.rawId)}">✕ Cancelar pedido</button>` : ''}
        </div>
      </div>
    `;
  }

  function nextStatus(cur) {
    const flow = ['pendente', 'preparando', 'entregando', 'entregue'];
    const i = flow.indexOf(cur);
    if (i === -1 || i === flow.length - 1) return null;
    return flow[i + 1];
  }

  function prevStatus(cur) {
    const flow = ['pendente', 'preparando', 'entregando', 'entregue'];
    const i = flow.indexOf(cur);
    if (i <= 0 || i === -1) return null;
    return flow[i - 1];
  }

  function nextLabelFor(next) {
    return next === 'preparando' ? '🔵 Preparar'
         : next === 'entregando' ? '🟣 Enviar'
         : next === 'entregue'   ? '🟢 Entregar'
         : '→ Avançar';
  }

  const STATUS_NAMES = {
    pendente: 'Pendente', preparando: 'Preparando', entregando: 'Entregando',
    entregue: 'Entregue', cancelado: 'Cancelado'
  };

  function statusName(st) {
    return STATUS_NAMES[st] || String(st || '').charAt(0).toUpperCase() + String(st || '').slice(1);
  }

  function afterChange(id, newStatus) {
    try {
      if (typeof window.logActivity === 'function') {
        window.logActivity('🔄', `Pedido #${id} → ${statusName(newStatus)}`);
      }
      if (typeof window.toast === 'function') {
        window.toast(`✅ Status atualizado para "${statusName(newStatus)}"`);
      }
    } catch (e) {}
    setTimeout(renderKanban, 150);
  }

  function bindKanbanEvents() {
    document.querySelectorAll('#pedViewKanban .kanban-card-actions .btn').forEach((btn) => {
      if (btn.__bound) return;
      btn.__bound = true;
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const action = btn.getAttribute('data-action');
        const id = btn.getAttribute('data-id');
        if (action === 'advance') {
          const next = btn.getAttribute('data-next');
          if (changeStatus(id, next)) afterChange(id, next);
        } else if (action === 'back') {
          const prev = btn.getAttribute('data-prev');
          if (changeStatus(id, prev)) afterChange(id, prev);
        } else if (action === 'cancel') {
          showConfirm(`Cancelar o pedido ${id}?`, () => {
            if (changeStatus(id, 'cancelado')) {
              try {
                if (typeof window.toast === 'function') window.toast('🗑 Pedido cancelado');
              } catch (err) {}
              setTimeout(renderKanban, 150);
            }
          });
        }
      });
    });

    document.querySelectorAll('#pedViewKanban .kanban-card').forEach((card) => {
      if (card.__bound) return;
      card.__bound = true;
      card.addEventListener('dragstart', (e) => {
        e.dataTransfer.setData('text/plain', card.getAttribute('data-id'));
        e.dataTransfer.effectAllowed = 'move';
        card.classList.add('dragging');
      });
      card.addEventListener('dragend', () => card.classList.remove('dragging'));
    });

    document.querySelectorAll('#pedViewKanban .kanban-col-body').forEach((col) => {
      if (col.__bound) return;
      col.__bound = true;
      col.addEventListener('dragover', (e) => {
        e.preventDefault();
        e.dataTransfer.dropEffect = 'move';
        col.classList.add('drag-over');
      });
      col.addEventListener('dragleave', () => col.classList.remove('drag-over'));
      col.addEventListener('drop', (e) => {
        e.preventDefault();
        col.classList.remove('drag-over');
        const id = e.dataTransfer.getData('text/plain');
        const newStatus = col.getAttribute('data-status');
        if (!id || !newStatus) return;
        if (changeStatus(id, newStatus)) setTimeout(renderKanban, 150);
      });
    });
  }

  function setView(view) {
    if (!VALID_VIEWS.includes(view)) view = 'list';
    currentView = view;
    try { localStorage.setItem(STORAGE_KEY, view); } catch (e) {}

    document.querySelectorAll('#pedViewSwitch .view-switch-btn').forEach((b) => {
      b.classList.toggle('active', b.getAttribute('data-view') === view);
    });

    const listEl = document.getElementById('pedViewList');
    const kanbanEl = document.getElementById('pedViewKanban');
    if (listEl) listEl.classList.toggle('active', view === 'list');
    if (kanbanEl) kanbanEl.classList.toggle('active', view === 'kanban');

    if (view === 'kanban') renderKanban();
  }

  function hookTable() {
    const tbl = document.getElementById('tblPed');
    if (!tbl) return;
    const obs = new MutationObserver(() => {
      if (currentView === 'kanban') {
        clearTimeout(window.__pkvT);
        window.__pkvT = setTimeout(renderKanban, 80);
      }
    });
    obs.observe(tbl, { childList: true, subtree: true });
  }

  function init() {
    let saved = 'list';
    try { saved = localStorage.getItem(STORAGE_KEY) || 'list'; } catch (e) {}
    if (!VALID_VIEWS.includes(saved)) saved = 'list';

    document.querySelectorAll('#pedViewSwitch .view-switch-btn').forEach((b) => {
      b.addEventListener('click', () => setView(b.getAttribute('data-view')));
    });

    ['pedFilter','pedStatusFilter','pedPeriodFilter'].forEach((id) => {
      const el = document.getElementById(id);
      if (!el) return;
      el.addEventListener('input', () => { if (currentView === 'kanban') renderKanban(); });
      el.addEventListener('change', () => { if (currentView === 'kanban') renderKanban(); });
    });

    setView(saved);
    hookTable();

    document.querySelectorAll('.sb-item[data-tab="ped"]').forEach((btn) => {
      btn.addEventListener('click', () => {
        if (currentView === 'kanban') setTimeout(renderKanban, 80);
      });
    });

    window.addEventListener('storage', (e) => {
      if (e.key === STATE_KEY && currentView === 'kanban') renderKanban();
    });

    window.addEventListener('orders:updated', () => {
      if (currentView === 'kanban') renderKanban();
    });

    window.addEventListener('focus', () => {
      if (currentView === 'kanban') renderKanban();
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

  window.PedView = { setView, renderKanban, getView: () => currentView };
})();