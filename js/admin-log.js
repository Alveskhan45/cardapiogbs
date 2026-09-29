/* ==================== LOG DE ATIVIDADES ==================== */
function renderAdminLog() {
  const el = $('adminLog');
  if (!el) return;

  if (!state.adminLog.length) {
    el.innerHTML = '<div class="empty">Nenhuma atividade registrada ainda</div>';
    return;
  }

  el.innerHTML = '<div class="log-list">' + state.adminLog.map(l => `
    <div class="log-item">
      <div class="log-ico">${esc(l.icon)}</div>
      <div class="log-body">
        <strong>${esc(l.text)}</strong>
        <small>${fmtDateTime(l.date)} • ${timeAgo(l.date)}</small>
      </div>
    </div>
  `).join('') + '</div>';

  const btn = $('btnClearLog');
  if (btn) btn.onclick = () => {
    showConfirm('Limpar todo o log de atividades?', () => {
      state.adminLog = [];
      save();
      renderAdminLog();
      toast('🗑 Log limpo');
    });
  };
}

/* ==================== HISTÓRICO DE ESTOQUE ==================== */
function renderStockLogList() {
  const el = $('stockLog');
  if (!el) return;

  if (!state.stockLog.length) {
    el.innerHTML = '<div class="dash-empty">Sem movimentações ainda</div>';
    return;
  }

  el.innerHTML = state.stockLog.slice(0, 15).map(l => `
    <div class="dash-item">
      <span>${esc(l.icon)} ${esc(l.text)}</span>
      <small style="color:var(--muted);font-size:.75rem">${timeAgo(l.date)}</small>
    </div>
  `).join('');

  const btnClear = $('btnClearStockLog');
  if (btnClear) btnClear.onclick = () => {
    showConfirm('Limpar histórico de estoque?', () => {
      state.stockLog = [];
      save();
      renderStockLogList();
      toast('🗑 Histórico limpo');
    });
  };
}