/* ============================================================
   js/super-admin.js — painel da plataforma (Super Admin completo)
   6 abas: Lojas, Pagamentos & Liberação, Planos, Mensagens,
   Receita, Auditoria + 5 modais operacionais.
   Rotas /api/super-admin/* (sem tenant, token Bearer super-admin).
   ============================================================ */
(function () {
  'use strict';

  var TOKEN_KEY = 'super_admin_token';
  var state = {
    token: '', page: 1, perPage: 25, total: 0,
    tenants: [], plans: [], templates: {}, pixKey: '', pixName: '',
    tenantMap: {}, auditTotal: 0,
    waCtx: null, planCtx: null, suspCtx: null, pwCtx: null, lastCreated: null,
    platformWa: '', alertWaText: '',
    notify: { booted: false, pending: 0, tenants: 0, leads: 0, timer: null }
  };
  var ORIG_TEMPLATES = {};

  var $ = function (id) { return document.getElementById(id); };
  var esc = function (s) {
    return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  };
  var brl = function (v) { return 'R$ ' + (Number(v) || 0).toFixed(2).replace('.', ','); };
  var dt = function (iso) { try { return iso ? new Date(iso).toLocaleDateString('pt-BR') : '—'; } catch (e) { return '—'; } };
  var dtt = function (iso) { try { return iso ? new Date(iso).toLocaleString('pt-BR') : '—'; } catch (e) { return '—'; } };

  function toast(msg) {
    var t = $('toast'); if (!t) return;
    t.textContent = msg; t.classList.add('on');
    clearTimeout(toast._t);
    toast._t = setTimeout(function () { t.classList.remove('on'); }, 2600);
  }

  function getToken() { try { return localStorage.getItem(TOKEN_KEY) || ''; } catch (e) { return ''; } }
  function setToken(t) {
    try { t ? localStorage.setItem(TOKEN_KEY, t) : localStorage.removeItem(TOKEN_KEY); } catch (e) {}
    state.token = t || '';
  }

  async function api(method, path, body) {
    var headers = { 'Content-Type': 'application/json' };
    if (state.token) headers['Authorization'] = 'Bearer ' + state.token;
    var res;
    try {
      res = await fetch(path, { method: method, headers: headers, body: body ? JSON.stringify(body) : undefined });
    } catch (e) {
      return { ok: false, status: 0, error: 'Servidor fora do ar' };
    }
    var data = null;
    try { data = await res.json(); } catch (e) {}
    if (!data) data = { ok: false, error: 'Resposta inválida (' + res.status + ')' };
    data.status = res.status;
    if (res.status === 401) { setToken(''); showLogin(); }
    return data;
  }

  function showLogin() { stopNotifyPolling(); $('dash').classList.add('hidden'); $('login').classList.remove('hidden'); }
  function showDash(me) {
    $('login').classList.add('hidden'); $('dash').classList.remove('hidden');
    $('whoami').textContent = (me && (me.email || me.name)) || 'super-admin';
  }
  function openModal(id) { $(id).classList.remove('hidden'); }
  function closeModal(id) { $(id).classList.add('hidden'); }

  /* ------------------- abas ------------------- */
  function switchTab(name) {
    document.querySelectorAll('#tabs button').forEach(function (b) {
      b.classList.toggle('active', b.dataset.tab === name);
    });
    document.querySelectorAll('[data-pane]').forEach(function (p) {
      p.classList.toggle('hidden', p.dataset.pane !== name);
    });
    var titles = { tenants: 'Lojas Clientes', notifications: 'Notificações', plans: 'Planos & Precificação', messages: 'Mensagens & WhatsApp', billing: 'Receita & Assinaturas', audit: 'Auditoria Global', settings: 'Configurações' };
    var titleEl = $('adminPageTitle');
    if (titleEl && titles[name]) titleEl.textContent = titles[name];
    if (window.innerWidth <= 900) { var sb = $('admin-sidebar'); if (sb) sb.classList.remove('open'); }
    if (name === 'notifications') { loadSubs(); loadLeads(); loadPayments(); }
    if (name === 'plans') loadPlans();
    if (name === 'messages') ensureMsgData();
    if (name === 'billing') loadRevenue();
    if (name === 'audit') loadAudit();
    if (name === 'settings') loadAccount();
    if (name === 'settings') loadSupport();
  }

  /* ------------------- KPIs ------------------- */
  async function loadStats() {
    var res = await api('GET', '/api/super-admin/stats');
    if (!res.ok) { $('kpis').innerHTML = ''; return; }
    var s = res.stats;
    var t = s.tenants || {};
    var cards = [
      ['💲', 'MRR Mensal', brl(s.mrr), 'Receita recorrente'],
      ['🏢', 'Lojas Ativas', (t.active || 0) + ' / ' + (t.total || 0), (t.trial || 0) + ' em trial'],
      ['🔒', 'Suspensas', t.suspended || 0, 'Inadimplência ou atraso', (t.suspended || 0) > 0],
      ['📈', 'GMV da Rede', brl(s.gmv), 'Vendas totais geradas'],
      ['🛍️', 'Total Pedidos', (s.orders || {}).total || 0, 'Em todas as lojas'],
      ['💳', 'Planos Pagos', t.paid || 0, 'Start & Pro']
    ];
    $('kpis').innerHTML = cards.map(function (c) {
      return '<div class="kpi' + (c[4] ? ' alert' : '') + '"><small>' + c[0] + ' ' + esc(c[1]) + '</small><strong>' + esc(String(c[2])) + '</strong><br><span class="sub2">' + esc(c[3]) + '</span></div>';
    }).join('');
    $('cTenants').textContent = t.total || 0;
    var pend = s.pendingPayments || 0;
    $('cPays').textContent = pend;
    $('pendingCount').textContent = pend;
    var badge = $('bPays');
    badge.textContent = pend; badge.classList.toggle('hidden', !pend);
    $('btnPending').classList.toggle('pulse', pend > 0);
    var banner = $('payBanner');
    if (pend > 0) {
      $('payBannerTxt').textContent = '🔔 Atenção: Há ' + pend + ' pagamento(s) de lojista informado(s) aguardando sua validação para liberação imediata!';
      banner.classList.add('show');
    } else banner.classList.remove('show');
    evaluateNotifications(s);
  }

  /* ------------------- ABA 1: lojas ------------------- */
  function planPrice(id) {
    var p = state.plans.find(function (x) { return x.id === id; });
    return p ? Number(p.priceMonthly || 0) : 0;
  }
  function planLabel(id) {
    var p = state.plans.find(function (x) { return x.id === id; });
    return p ? p.name : id;
  }
  function storeUrl(t) {
    if (location.hostname === 'localhost' || location.hostname === '127.0.0.1')
      return '/?tenant=' + encodeURIComponent(t.subdomain);
    return 'https://' + t.subdomain + '.' + location.hostname.replace(/^[^.]+\./, '');
  }

  async function loadTenants() {
    var q = encodeURIComponent(($('q').value || '').trim());
    var st = encodeURIComponent($('fStatus').value || '');
    var pl = encodeURIComponent($('fPlan').value || '');
    var url = '/api/super-admin/tenants';
    if (q) url += '?search=' + q;
    if (st) url += (q ? '&' : '?') + 'status=' + st;
    if (pl) url += (q || st ? '&' : '?') + 'plan=' + pl;
    var res = await api('GET', url);
    if (!res.ok) { $('tbody').innerHTML = '<tr><td colspan="5" class="empty">' + esc(res.error || 'erro') + '</td></tr>'; return; }
    state.total = res.total;
    state.tenants = res.tenants || [];
    state.tenantMap = {};
    state.tenants.forEach(function (t) { state.tenantMap[t.id] = t; });
    if ($('pageInfo')) $('pageInfo').textContent = res.total + ' loja(s) cadastrada(s)';
    $('tenantCount').textContent = 'Exibindo todas as ' + state.tenants.length + ' loja(s) cadastradas';
    if (!state.tenants.length) {
      $('tbody').innerHTML = '<tr><td colspan="5" class="empty">Nenhuma loja encontrada.</td></tr>';
      return;
    }
    $('tbody').innerHTML = state.tenants.map(function (t) {
      var color = t.primaryColor || '#7c3aed';
      var initial = esc((t.name || '?').trim().charAt(0).toUpperCase());
      var statusPill = t.status === 'active' ? '<span class="pill active">✔ Ativa</span>'
        : t.status === 'trial' ? '<span class="pill trial">⏳ Período de Testes</span>'
        : t.status === 'suspended' ? '<span class="pill suspended">🔒 Suspensa (Inadimplência)</span>'
        : '<span class="pill cancelled">' + esc(t.status) + '</span>';
      return '<tr>'
        + '<td><div class="store-id"><span class="avatar" style="background:' + esc(color) + '">' + initial + '</span>'
        + '<span><b>' + esc(t.name) + '</b><br><a class="mono" href="' + esc(storeUrl(t)) + '" target="_blank" rel="noopener">/' + esc(t.subdomain) + '</a>'
        + (t.cnpj ? '<br><small style="color:var(--dim)">' + esc(t.cnpj) + '</small>' : '') + '</span></div></td>'
        + '<td><span class="pill ' + esc(t.plan) + '">' + esc(planLabel(t.plan)) + '</span><br><small>' + brl(planPrice(t.plan)) + '/mês</small></td>'
        + '<td>' + statusPill + '</td>'
        + '<td>' + t.orders30d + ' pedidos<br><small>' + brl(t.revenue30d) + '</small></td>'
        + '<td><div class="acts">'
        + '<button data-act="menu" data-id="' + t.id + '" title="Ver cardápio">👁 Cardápio</button>'
        + '<button data-act="imp" data-id="' + t.id + '" title="Entrar como dono">🔑 Painel</button>'
        + '<button data-act="plan" data-id="' + t.id + '" data-plan="' + esc(t.plan) + '">🔄 Plano</button>'
        + '<button data-act="toggle" data-id="' + t.id + '" data-status="' + esc(t.status) + '">'
        + (t.status === 'suspended' ? '✅ Ativar' : '🔒 Suspender') + '</button>'
        + '<button data-act="pw" data-id="' + t.id + '">🔑 Senha</button>'
        + '<button data-act="wa" data-id="' + t.id + '">💬 WhatsApp</button>'
        + '<button data-act="del" data-id="' + t.id + '" data-name="' + esc(t.name) + '">🗑 Excluir</button>'
        + '</div></td></tr>';
    }).join('');
    refreshMsgTenantSelect();
  }

  async function rowAction(btn) {
    var act = btn.dataset.act, id = btn.dataset.id;
    var t = state.tenantMap[id];
    if (act === 'menu' && t) { window.open(storeUrl(t), '_blank', 'noopener'); return; }
    if (act === 'imp') {
      var r1 = await api('POST', '/api/super-admin/tenants/' + id + '/impersonate');
      if (!r1.ok) { toast(r1.error || 'Falha ao entrar'); return; }
      try {
        sessionStorage.setItem('imp_token', r1.token);
        sessionStorage.setItem('imp_tenant', r1.tenant.subdomain);
        localStorage.setItem('dev_tenant', r1.tenant.subdomain);
      } catch (e) {}
      window.open('/?imp=1', '_blank', 'noopener');
      toast('Abrindo painel de ' + r1.tenant.name);
      return;
    }
    if (act === 'plan') { openPlanModal(id); return; }
    if (act === 'toggle') {
      var cur = btn.dataset.status;
      if (cur === 'suspended') {
        var r3 = await api('PUT', '/api/super-admin/tenants/' + id, { status: 'active' });
        toast(r3.ok ? 'Loja reativada' : (r3.error || 'Falha'));
        if (r3.ok) { await refreshAll(); openWaModal(id, 'reactivationNotice'); }
      } else openSuspendModal(id);
      return;
    }
    if (act === 'pw') { openPwModal(id); return; }
    if (act === 'wa') { openWaModal(id, 'billingReminder'); return; }
    if (act === 'del') {
      var nome = btn.dataset.name;
      if (!confirm('Remover a loja "' + nome + '"?\n\nOs dados e a senha dela param de funcionar na hora.')) return;
      var r4 = await api('DELETE', '/api/super-admin/tenants/' + id);
      toast(r4.ok ? 'Loja removida' : (r4.error || 'Falha'));
      if (r4.ok) await refreshAll();
    }
  }

  /* ------------------- ABA 2: pagamentos ------------------- */
  async function loadPayments() {
    var f = $('payFilter').value || 'pending';
    var res = await api('GET', '/api/super-admin/payments?status=' + encodeURIComponent(f));
    if (!res.ok) { $('payList').innerHTML = '<div class="empty">' + esc(res.error || 'erro') + '</div>'; return; }
    var list = res.payments || [];
    if (!list.length) { $('payList').innerHTML = '<div class="empty">Nenhum comprovante ' + (f === 'pending' ? 'pendente' : '') + '.</div>'; return; }
    $('payList').innerHTML = list.map(function (p) {
      var pend = p.status === 'pending';
      return '<div class="paycard"><b>' + esc(p.tenant_name) + '</b> <span class="mono">/' + esc(p.subdomain) + '</span> '
        + '<span class="pill ' + esc(p.plan) + '">' + esc(planLabel(p.plan)) + ' • ' + brl(p.amount) + '</span> '
        + (pend ? '<span class="pill suspended">⏳ Pendente de Validação</span>' : '<span class="pill ' + (p.status === 'approved' ? 'active' : 'cancelled') + '">' + esc(p.status) + '</span>')
        + '<br><small>Enviado em ' + dtt(p.created_at) + (p.created_by ? ' por ' + esc(p.created_by) : '') + '</small>'
        + (p.note ? '<br><small>📝 ' + esc(p.note) + '</small>' : '')
        + (pend ? '<div class="row" style="margin:12px 0 0"><button class="green" data-pay="ok" data-id="' + p.id + '" data-tenant="' + p.tenant_id + '">✔ Aprovar Pagamento e Liberar Loja</button>'
          + '<button data-pay="wa" data-tenant="' + p.tenant_id + '">💬 Falar com Lojista</button>'
          + '<button class="ghost" data-pay="no" data-id="' + p.id + '">Rejeitar</button></div>' : '')
        + '</div>';
    }).join('');
  }

  async function payAction(btn) {
    var kind = btn.dataset.pay, id = btn.dataset.id, tid = btn.dataset.tenant;
    if (kind === 'wa') { openWaModal(tid, 'billingReminder'); return; }
    if (kind === 'no') {
      if (!confirm('Rejeitar este comprovante?')) return;
      var rj = await api('POST', '/api/super-admin/payments/' + id + '/reject');
      toast(rj.ok ? 'Comprovante rejeitado' : (rj.error || 'Falha'));
      if (rj.ok) { await loadPayments(); await loadStats(); }
      return;
    }
    var r = await api('POST', '/api/super-admin/payments/' + id + '/approve');
    if (!r.ok) { toast(r.error || 'Falha'); return; }
    toast('Loja liberada com sucesso!');
    await loadPayments(); await refreshAll();
    openWaModal(tid, 'reactivationNotice');
  }

  /* ------------------- leads de contratação (landing) ------------------- */
  async function loadLeads() {
    var box = $('leadList'); if (!box) return;
    var st = $('leadFilter') ? ($('leadFilter').value || 'new') : 'new';
    var res = await api('GET', '/api/super-admin/leads?status=' + encodeURIComponent(st));
    if (!res.ok) { box.innerHTML = '<div class="empty">' + esc(res.error || 'erro') + '</div>'; return; }
    var list = res.leads || [];
    if (!list.length) { box.innerHTML = '<div class="empty">Nenhuma contratação registrada ainda.</div>'; return; }
    var stLabels = { new: 'Novo', contacted: 'Em contato', converted: 'Convertido', archived: 'Arquivado' };
    box.innerHTML = list.map(function (l) {
      var plano = l.plan ? planLabel(l.plan) : 'Contato';
      var waDigits = String(l.whatsapp || '').replace(/\D/g, '');
      return '<div class="paycard">'
        + '<strong>' + esc(l.name || 'Visitante') + '</strong> <span class="badge-sa">' + esc(stLabels[l.status] || l.status) + '</span>'
        + ' <span class="badge-sa">' + esc(plano) + '</span>'
        + '<br><small>Origem: ' + esc(l.source || 'landing') + ' • ' + dtt(l.created_at) + '</small>'
        + (l.message ? '<br><small>📝 ' + esc(l.message) + '</small>' : '')
        + '<div class="row" style="margin:12px 0 0">'
        + (waDigits ? '<button class="green" data-lead="wa" data-wa="' + esc(waDigits) + '">💬 Falar no WhatsApp</button>' : '')
        + (l.status === 'new' ? '<button data-lead="contacted" data-id="' + l.id + '">Marcar em contato</button>' : '')
        + (l.status !== 'archived' ? '<button class="ghost" data-lead="archived" data-id="' + l.id + '">Arquivar</button>' : '')
        + '</div></div>';
    }).join('');
  }

  /* ------------------- assinaturas (contratação self-service) ------------- */
  async function loadSubs() {
    var box = $('subList'); if (!box) return;
    var st = ($('subFilter') && $('subFilter').value) || 'awaiting_payment';
    var res = await api('GET', '/api/super-admin/subscriptions?status=' + encodeURIComponent(st));
    if (!res.ok) { box.innerHTML = '<div class="empty">' + esc(res.error || 'erro') + '</div>'; return; }
    var list = res.subscriptions || [];
    if (!list.length) { box.innerHTML = '<div class="empty">Nenhuma assinatura nesta etapa.</div>'; return; }
    box.innerHTML = list.map(function (s) {
      var wa = String(s.phone || '').replace(/\D/g, '');
      var podeLiberar = s.status !== 'active';
      return '<div class="paycard">'
        + '<strong>' + esc(s.storeName) + '</strong> <span class="mono">/' + esc(s.subdomain) + '</span> '
        + '<span class="pill ' + esc(s.plan) + '">' + esc(s.planName) + ' • ' + brl(s.price) + '</span> '
        + '<span class="pill ' + (s.status === 'active' ? 'active' : 'suspended') + '">' + esc(s.statusLabel) + '</span>'
        + '<br><small>Login: ' + esc(s.login || '—') + ' • criada em ' + dtt(s.createdAt) + '</small>'
        + (s.accessCode ? '<br><small>🔑 Código de acesso: <b>' + esc(s.accessCode) + '</b></small>' : '')
        + (s.renewsAt ? '<br><small>Renova em: ' + dtt(s.renewsAt) + '</small>' : '')
        + '<div class="row" style="margin:12px 0 0">'
        + (wa ? '<button class="green" data-sub="wa" data-wa="' + esc(wa) + '" data-name="' + esc(s.storeName) + '" data-plan="' + esc(s.planName) + '" data-price="' + brl(s.price) + '">💬 Enviar chave PIX</button>' : '')
        + (podeLiberar ? '<button data-sub="activate" data-id="' + s.id + '" data-name="' + esc(s.storeName) + '" data-plan="' + esc(s.planName) + '">✔ Liberar acesso (30 dias)</button>' : '')
        + '</div></div>';
    }).join('');
  }

  async function subAction(btn) {
    var kind = btn.dataset.sub;
    if (kind === 'wa') {
      var msg = 'Olá, ' + (btn.dataset.name || '') + '! 👋\n\n'
        + 'Recebemos seu cadastro no CardapioDigital SaaS (plano ' + btn.dataset.plan + ').\n'
        + 'Valor mensal: ' + btn.dataset.price + '\n\n'
        + 'Pague via PIX na chave: ' + (state.pixKey || '(configure a chave PIX na aba Mensagens)') + '\n'
        + 'Assim que confirmar, é só responder esta mensagem.';
      window.open('https://wa.me/' + btn.dataset.wa + '?text=' + encodeURIComponent(msg), '_blank', 'noopener');
      return;
    }
    if (!confirm('Liberar o acesso ao plano ' + btn.dataset.plan + ' por 30 dias para "' + btn.dataset.name + '"?')) return;
    var r = await api('POST', '/api/super-admin/subscriptions/' + encodeURIComponent(btn.dataset.id) + '/activate');
    if (!r.ok) { toast(r.error || 'Falha ao liberar'); return; }
    toast('Acesso liberado por 30 dias!');
    await loadSubs(); await refreshAll();
    showSaAlert('🔓 Acesso liberado',
      btn.dataset.name + ' • ' + btn.dataset.plan + ' • código ' + (r.accessCode || '—'),
      'CardapioDigital SaaS: acesso liberado! Loja ' + btn.dataset.name + ' — plano ' + btn.dataset.plan + ' ativo por 30 dias. Código de acesso: ' + (r.accessCode || 'consulte o painel') + '. Login: /?tenant=');
  }

  async function leadAction(btn) {
    var kind = btn.dataset.lead;
    if (kind === 'wa') {
      var digits = btn.dataset.wa || '';
      if (digits) window.open('https://wa.me/' + digits, '_blank', 'noopener');
      return;
    }
    var r = await api('PUT', '/api/super-admin/leads/' + encodeURIComponent(btn.dataset.id), { status: kind });
    if (!r.ok) { toast(r.error || 'Falha'); return; }
    toast(kind === 'archived' ? 'Contato arquivado' : 'Marcado como em contato');
    await loadLeads(); await loadStats();
  }

  /* ------------------- ABA 3: planos ------------------- */
  var FEAT_LABELS = { kds: 'KDS de Cozinha em Tela Cheia', coupons: 'Cupons de Desconto', delivery_zones: 'Zonas Geográficas e Roteirização', reports: 'Relatórios Financeiros e Livro-Caixa', loyalty: 'Fidelidade e Cashback', multi_users: 'Multi-usuários com RBAC', api_access: 'Acesso à API', custom_domain: 'Domínio Próprio', white_label: 'White Label', priority_support: 'Suporte Prioritário via WhatsApp' };

  async function loadPlans() {
    var res = await api('GET', '/api/super-admin/plans');
    if (!res.ok) { $('planGrid').innerHTML = '<div class="empty">' + esc(res.error || 'erro') + '</div>'; return; }
    state.plans = res.plans || [];
    $('planGrid').innerHTML = state.plans.map(function (p) {
      var lim = p.limits || {}, feat = p.features || {};
      var limHtml = ['products', 'orders_month', 'users', 'bairros', 'storage_mb'].map(function (k) {
        return '<label>' + k + ' (0/-1 = ∞)</label><input type="number" min="-1" step="1" data-plan="' + esc(p.id) + '" data-field="lim_' + k + '" value="' + esc(lim[k] == null ? -1 : lim[k]) + '">';
      }).join('');
      var featHtml = Object.keys(FEAT_LABELS).map(function (k) {
        return '<label><input type="checkbox" data-plan="' + esc(p.id) + '" data-field="feat_' + k + '"' + (feat[k] ? ' checked' : '') + ' style="width:auto"> ' + FEAT_LABELS[k] + '</label>';
      }).join('');
      return '<div class="plan"><b>' + esc(p.id) + '</b>'
        + '<label>Nome Comercial</label><input type="text" data-plan="' + esc(p.id) + '" data-field="name" value="' + esc(p.name || '') + '">'
        + '<label>Preço Mensal (R$)</label><input type="number" step="0.01" min="0" data-plan="' + esc(p.id) + '" data-field="price" value="' + esc(p.priceMonthly || 0) + '">'
        + limHtml + '<div class="feats">' + featHtml + '</div>'
        + '<button class="primary" style="width:100%;margin-top:12px" data-saveplan="' + esc(p.id) + '">Salvar Alterações de Planos</button></div>';
    }).join('');
  }

  async function savePlan(id) {
    var q = function (f) { return document.querySelector('[data-plan="' + id + '"][data-field="' + f + '"]'); };
    var limits = {};
    ['products', 'orders_month', 'users', 'bairros', 'storage_mb'].forEach(function (k) {
      var el = q('lim_' + k);
      limits[k] = el ? Number(el.value) : -1;
    });
    var features = {};
    Object.keys(FEAT_LABELS).forEach(function (k) {
      var el = q('feat_' + k);
      features[k] = el ? !!el.checked : false;
    });
    var body = {
      name: q('name') ? q('name').value : undefined,
      priceMonthly: q('price') ? Number(q('price').value) : undefined,
      limits: limits, features: features
    };
    var r = await api('PUT', '/api/super-admin/plans/' + encodeURIComponent(id), body);
    if (!r.ok) { toast(r.error || 'Falha ao salvar'); return; }
    toast('Configurações de planos salvas! MRR: ' + brl(r.mrr));
    await loadPlans(); await loadStats();
  }

  /* ------------------- motor de tags (11 variáveis) ------------------- */
  var TAGS = ['{NOME_LOJISTA}', '{NOME_LOJA}', '{PLANO}', '{VALOR_PLANO}', '{LINK_CARDAPIO}', '{LINK_PAINEL}', '{LOGIN_EMAIL}', '{SENHA_INICIAL}', '{CHAVE_PIX_SAAS}', '{TITULAR_PIX_SAAS}', '{DATA_VENCIMENTO}'];

  function tagValues(ctx) {
    var t = (ctx && ctx.tenant) || {};
    var origin = location.origin;
    var due = (ctx && (ctx.dueDate || t.subscriptionExpiresAt || t.trialEndsAt)) || '';
    return {
      '{NOME_LOJISTA}': (ctx && ctx.ownerName) || t.name || '',
      '{NOME_LOJA}': t.name || '',
      '{PLANO}': planLabel(t.plan),
      '{VALOR_PLANO}': brl(planPrice(t.plan)),
      '{LINK_CARDAPIO}': origin + '/?tenant=' + (t.subdomain || ''),
      '{LINK_PAINEL}': origin + '/?tenant=' + (t.subdomain || ''),
      '{LOGIN_EMAIL}': (ctx && ctx.ownerEmail) || '',
      '{SENHA_INICIAL}': (ctx && ctx.password) || '',
      '{CHAVE_PIX_SAAS}': state.pixKey || '',
      '{TITULAR_PIX_SAAS}': state.pixName || '',
      '{DATA_VENCIMENTO}': due ? new Date(due).toLocaleDateString('pt-BR') : '—'
    };
  }
  function compileTpl(text, ctx) {
    var vals = tagValues(ctx);
    var out = String(text || '');
    Object.keys(vals).forEach(function (k) { out = out.split(k).join(vals[k]); });
    return out;
  }
  function waLink(phone, text) {
    var digits = String(phone || '').replace(/\D/g, '');
    if (digits && !digits.startsWith('55')) digits = '55' + digits;
    return 'https://wa.me/' + (digits || '') + '?text=' + encodeURIComponent(text);
  }

  async function tenantDetail(id) {
    var res = await api('GET', '/api/super-admin/tenants/' + id);
    if (!res.ok) return null;
    return res;
  }
  async function buildCtx(id, extra) {
    var t = state.tenantMap[id];
    if (!t) {
      var d0 = await tenantDetail(id);
      if (d0 && d0.tenant) t = { id: d0.tenant.id, name: d0.tenant.name, subdomain: d0.tenant.subdomain, plan: d0.tenant.plan, phone: '' };
    }
    if (!t) return null;
    var ctx = { tenant: t, ownerEmail: '', ownerName: t.name, password: '', dueDate: t.subscriptionExpiresAt || t.trialEndsAt };
    var d = await tenantDetail(id);
    if (d) {
      if (d.users && d.users.length) { ctx.ownerEmail = d.users[0].email || ''; ctx.ownerName = d.users[0].name || t.name; }
      if (d.tenant) { ctx.tenant = Object.assign({}, t, { phone: d.tenant.phone || t.phone || '', cnpj: d.tenant.cnpj }); ctx.dueDate = d.tenant.subscription_expires_at || d.tenant.trial_ends_at || ctx.dueDate; }
    }
    return Object.assign(ctx, extra || {});
  }

  /* ------------------- ABA 4: mensagens ------------------- */
  async function ensureMsgData() {
    var rt = await api('GET', '/api/super-admin/templates');
    if (rt.ok) {
      state.templates = rt.templates || {};
      ORIG_TEMPLATES = JSON.parse(JSON.stringify(state.templates));
      state.pixKey = rt.pix_key || ''; state.pixName = rt.pix_name || '';
      $('pixKey').value = state.pixKey; $('pixName').value = state.pixName;
    }
    refreshMsgTenantSelect();
    renderTagBar(); renderMsgPreview();
  }
  function refreshMsgTenantSelect() {
    var sel = $('msgTenant');
    if (!sel || !state.tenants.length) return;
    var cur = sel.value;
    sel.innerHTML = state.tenants.map(function (t) {
      return '<option value="' + t.id + '">' + esc(t.name) + ' (/' + esc(t.subdomain) + ')</option>';
    }).join('');
    if (cur && state.tenantMap[cur]) sel.value = cur;
  }
  function renderTagBar() {
    $('tagBar').innerHTML = TAGS.map(function (tg) {
      return '<button data-tag="' + esc(tg) + '">+ ' + esc(tg) + '</button>';
    }).join('');
  }
  function currentMsgCtx() {
    var t = state.tenantMap[$('msgTenant').value];
    return { tenant: t || {}, ownerEmail: '', ownerName: (t && t.name) || '', password: '', dueDate: (t && (t.subscriptionExpiresAt || t.trialEndsAt)) || '' };
  }
  function renderMsgPreview() {
    var model = $('msgModel').value;
    if ($('msgText').value === '' || $('msgText').dataset.model !== model) {
      $('msgText').value = state.templates[model] || '';
      $('msgText').dataset.model = model;
    }
    $('msgPreview').textContent = compileTpl($('msgText').value, currentMsgCtx());
  }

  /* ------------------- ABA 5: receita ------------------- */
  async function loadRevenue() {
    var res = await api('GET', '/api/super-admin/revenue');
    if (!res.ok) { $('rev').innerHTML = '<div class="empty">' + esc(res.error || 'erro') + '</div>'; return; }
    var rows = res.revenue || [];
    var byPlan = res.revenueByPlan || [];
    var total = rows.length;
    var susp = rows.filter(function (r) { return r.status === 'suspended'; }).length;
    var inad = total ? Math.round((susp / total) * 100) : 0;
    $('billKpis').innerHTML =
      '<div class="kpi"><small>📊 ARR (MRR × 12)</small><strong>' + brl(res.mrr * 12) + '</strong></div>'
      + '<div class="kpi' + (susp ? ' alert' : '') + '"><small>⚠️ Inadimplência</small><strong>' + inad + '%</strong><br><span class="sub2">' + susp + ' de ' + total + ' suspensas</span></div>'
      + '<div class="kpi"><small>💰 MRR</small><strong>' + brl(res.mrr) + '</strong></div>';
    $('revPlans').innerHTML = '<table><thead><tr><th>Plano</th><th>Lojas</th><th>MRR</th></tr></thead><tbody>'
      + byPlan.map(function (r) {
        return '<tr><td><span class="pill ' + esc(r.plan) + '">' + esc(r.name) + '</span> <small>' + brl(r.priceMonthly) + '/mês</small></td><td>' + r.tenants + '</td><td>' + brl(r.mrr) + '</td></tr>';
      }).join('') + '</tbody></table>';
    if (!rows.length) { $('rev').innerHTML = '<div class="empty">Sem dados ainda.</div>'; return; }
    $('rev').innerHTML = '<table><thead><tr><th>Loja</th><th>Plano</th><th>Status</th><th>MRR</th><th>Receita 30d</th><th>Pedidos 30d</th><th>Vencimento</th></tr></thead><tbody>'
      + rows.map(function (r) {
        return '<tr><td>' + esc(r.name) + '</td>'
          + '<td><span class="pill ' + esc(r.plan) + '">' + esc(r.plan) + '</span></td>'
          + '<td><span class="pill ' + esc(r.status) + '">' + esc(r.status) + '</span></td>'
          + '<td>' + brl(r.priceMonthly) + '</td>'
          + '<td>' + brl(r.revenue30d) + '</td><td>' + r.orders30d + '</td>'
          + '<td>' + dt(r.subscriptionExpiresAt || r.trialEndsAt) + '</td></tr>';
      }).join('') + '</tbody></table>';
  }

  /* ------------------- ABA 6: auditoria ------------------- */
  async function loadAudit() {
    var res = await api('GET', '/api/super-admin/audit');
    if (!res.ok) { $('auditBody').innerHTML = '<tr><td colspan="5" class="empty">' + esc(res.error || 'erro') + '</td></tr>'; return; }
    state.auditTotal = res.total;
    $('auditInfo').textContent = res.total + ' evento(s) registrado(s) — exibindo todos';
    var list = res.audit || [];
    if (!list.length) { $('auditBody').innerHTML = '<tr><td colspan="5" class="empty">Sem eventos ainda.</td></tr>'; return; }
    $('auditBody').innerHTML = list.map(function (a) {
      return '<tr><td class="mono">' + dtt(a.created_at) + '</td><td><b>' + esc(a.action) + '</b></td>'
        + '<td>' + esc(a.actor_email || '—') + '<br><small class="mono">' + esc(a.ip || '') + '</small></td>'
        + '<td>' + (a.tenant_name ? esc(a.tenant_name) + ' <span class="mono">/' + esc(a.subdomain || '') + '</span>' : '—') + '</td>'
        + '<td class="mono"><small>' + esc(JSON.stringify(a.details || {})) + '</small></td></tr>';
    }).join('');
  }

  async function clearAudit() {
    var pw = prompt('Informe sua senha de Super Admin para confirmar a limpeza da auditoria.\nEsta ação é irreversível.');
    if (pw === null) return;
    if (!pw) { toast('Senha obrigatória'); return; }
    var r = await api('POST', '/api/super-admin/audit/clear', { password: pw });
    if (!r.ok) { toast(r.error || 'Falha ao limpar auditoria'); return; }
    toast('Auditoria limpa: ' + r.removed + ' registro(s) removido(s)');
    await loadAudit();
  }

  /* ------------------- MODAL 1: onboarding ------------------- */
  function slugify(s) {
    return String(s || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase()
      .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 100);
  }
  async function createTenant() {
    var err = $('newErr'); err.textContent = '';
    var body = {
      name: ($('nName').value || '').trim(),
      subdomain: slugify($('nSub').value),
      plan: $('nPlan').value,
      adminEmail: ($('nEmail').value || '').trim().toLowerCase(),
      demo: $('nDemo').checked,
      cnpj: ($('nCnpj').value || '').trim(),
      phone: ($('nPhone').value || '').trim(),
      address: ($('nAddr').value || '').trim(),
      primaryColor: $('nColor').value || ''
    };
    if ($('nTrial').checked) body.status = 'trial';
    var pass = ($('nPass').value || '').trim();
    if (pass) body.adminPassword = pass;
    $('btnCreate').disabled = true;
    var res = await api('POST', '/api/super-admin/tenants', body);
    $('btnCreate').disabled = false;
    if (!res.ok) { err.textContent = res.error || 'Não foi possível criar'; return; }
    closeModal('modalNew');
    state.lastCreated = { tenant: res.tenant, adminEmail: res.adminEmail, adminPassword: res.adminPassword };
    $('secWho').textContent = res.tenant.name + ' (' + res.tenant.subdomain + ') · ' + res.adminEmail;
    $('secBox').innerHTML = 'usuário: ' + esc(res.adminEmail) + '<br>senha: ' + esc(res.adminPassword);
    openModal('modalSecret');
    $('nName').value = $('nSub').value = $('nEmail').value = $('nPass').value = $('nCnpj').value = $('nPhone').value = $('nAddr').value = '';
    $('nTrial').checked = false;
    $('nDemo').checked = true;
    $('nPlan').value = 'pro';
    $('nColor').value = '#7c3aed';
    $('slugPreview').textContent = '';
    await refreshAll();
    toast('Loja criada');
  }

  /* ------------------- MODAL 2: trocar plano ------------------- */
  function openPlanModal(id) {
    var t = state.tenantMap[id]; if (!t) return;
    state.planCtx = { id: id, current: t.plan, selected: t.plan };
    $('planTitle').textContent = "Alterar Plano de '" + t.name + "'";
    $('planSub').textContent = 'Plano atual: ' + planLabel(t.plan) + ' (' + brl(planPrice(t.plan)) + '/mês)';
    var order = ['free', 'starter', 'pro'];
    $('planPick').innerHTML = order.map(function (pid) {
      return '<button data-pick="' + pid + '" class="' + (pid === t.plan ? 'sel' : '') + '"><b>' + esc(planLabel(pid)) + '</b> — ' + brl(planPrice(pid)) + '/mês' + (pid === t.plan ? ' (atual)' : '') + '</button>';
    }).join('');
    $('planWarn').classList.add('hidden');
    $('planConfirm').disabled = true;
    openModal('modalPlan');
  }
  async function confirmPlan() {
    var ctx = state.planCtx; if (!ctx || ctx.selected === ctx.current) return;
    var r = await api('PUT', '/api/super-admin/tenants/' + ctx.id, { plan: ctx.selected });
    if (!r.ok) { toast(r.error || 'Falha'); return; }
    closeModal('modalPlan');
    toast('Plano alterado para ' + planLabel(ctx.selected));
    await refreshAll();
  }

  /* ------------------- MODAL 3: suspender/reativar ------------------- */
  function openSuspendModal(id) {
    var t = state.tenantMap[id]; if (!t) return;
    state.suspCtx = { id: id };
    $('suspTitle').textContent = 'Suspender Loja por Inadimplência?';
    $('suspTxt').textContent = 'Ao suspender "' + t.name + '", o cardápio público e novos pedidos serão bloqueados imediatamente. Em seguida abriremos a cobrança no WhatsApp com a chave PIX.';
    openModal('modalSuspend');
  }
  async function confirmSuspend() {
    var ctx = state.suspCtx; if (!ctx) return;
    var r = await api('PUT', '/api/super-admin/tenants/' + ctx.id, { status: 'suspended' });
    if (!r.ok) { toast(r.error || 'Falha'); return; }
    closeModal('modalSuspend');
    toast('Loja suspensa');
    await refreshAll();
    openWaModal(ctx.id, 'suspensionNotice');
  }

  /* ------------------- MODAL 4: WhatsApp ------------------- */
  async function openWaModal(id, model) {
    var ctx = await buildCtx(id, {});
    if (!ctx) { toast('Loja não encontrada'); return; }
    state.waCtx = ctx;
    $('waWho').textContent = 'Loja: ' + ctx.tenant.name + ' (/' + ctx.tenant.subdomain + ')';
    $('waModel').value = model || 'billingReminder';
    var showPass = $('waModel').value === 'onboarding';
    $('waPass').style.display = showPass ? '' : 'none';
    $('waPassLbl').style.display = showPass ? '' : 'none';
    renderWaPreview();
    openModal('modalWa');
  }
  function renderWaPreview() {
    if (!state.waCtx) return;
    var model = $('waModel').value;
    var showPass = model === 'onboarding';
    $('waPass').style.display = showPass ? '' : 'none';
    $('waPassLbl').style.display = showPass ? '' : 'none';
    if (showPass) state.waCtx.password = $('waPass').value || state.waCtx.password;
    $('waPreview').textContent = compileTpl(state.templates[model] || '', state.waCtx);
  }

  /* ------------------- MODAL 5: reset de senha ------------------- */
  async function openPwModal(id) {
    var ctx = await buildCtx(id, {});
    if (!ctx) { toast('Loja não encontrada'); return; }
    state.pwCtx = ctx;
    $('pwWho').textContent = ctx.tenant.name + ' (/' + ctx.tenant.subdomain + ') · ' + (ctx.ownerEmail || '');
    $('pwNew').value = '';
    $('pwMsg').textContent = 'Clique em "Gerar Nova" para criar a senha provisória.';
    openModal('modalPw');
  }
  async function genPassword() {
    var ctx = state.pwCtx; if (!ctx) return;
    var r = await api('POST', '/api/super-admin/tenants/' + ctx.tenant.id + '/password-reset');
    if (!r.ok) { toast(r.error || 'Falha'); return; }
    ctx.password = r.novaSenha; ctx.ownerEmail = r.email;
    $('pwNew').value = r.novaSenha;
    var msg = '🔑 *Sua Nova Senha de Acesso — ' + ctx.tenant.name + '*\nOlá! Sua senha do painel foi redefinida:\n👉 *Link do Painel:* ' + location.origin + '/?tenant=' + ctx.tenant.subdomain + '\n🔑 *Nova Senha:* ' + r.novaSenha + '\nVocê já pode entrar e gerenciar seus pedidos normalmente!';
    $('pwMsg').textContent = msg;
    ctx.pwMsg = msg;
  }

  /* ------------------- refresh ------------------- */
  async function refreshAll() {
    await Promise.all([loadStats(), loadTenants()]);
  }

  /* ------------------- notificações ------------------- */
  var NOTIF_KEY = 'super_admin_notif';
  var NOTIF_DEFAULTS = { desktop: true, sound: true, whatsapp: false };
  function getNotifPrefs() {
    var saved = {};
    try { saved = JSON.parse(localStorage.getItem(NOTIF_KEY) || '{}') || {}; } catch (e) {}
    return Object.assign({}, NOTIF_DEFAULTS, saved);
  }
  function saveNotifPrefs(patch) {
    var p = getNotifPrefs();
    if (patch) Object.assign(p, patch);
    try { localStorage.setItem(NOTIF_KEY, JSON.stringify(p)); } catch (e) {}
    updateNotifUI();
  }
  function notifPermission() {
    return (typeof Notification === 'undefined') ? 'unsupported' : Notification.permission;
  }
  function updateNotifUI() {
    var p = getNotifPrefs();
    var perm = notifPermission();
    if ($('notifDesktop')) $('notifDesktop').checked = !!p.desktop;
    if ($('notifSound')) $('notifSound').checked = !!p.sound;
    if ($('notifWhatsapp')) $('notifWhatsapp').checked = !!p.whatsapp;
    var hint = $('notifPermHint');
    if (hint) {
      if (perm === 'unsupported') hint.textContent = 'Este navegador não suporta notificações.';
      else if (perm === 'granted') hint.textContent = '✓ Permissão concedida pelo navegador.';
      else if (perm === 'denied') hint.textContent = '✕ Bloqueada — libere nas permissões do navegador.';
      else hint.textContent = 'Permissão ainda não solicitada.';
    }
    var btn = $('notifPermBtn');
    if (btn) btn.classList.toggle('hidden', perm === 'granted' || perm === 'unsupported');
  }
  function requestNotifPerm() {
    if (typeof Notification === 'undefined') { toast('Este navegador não tem notificações'); return; }
    Notification.requestPermission().then(function (p) {
      updateNotifUI();
      if (p === 'granted') { toast('Notificações do navegador ativadas'); playBeep(); }
      else if (p === 'denied') toast('Notificação bloqueada pelo navegador');
    });
  }
  function playBeep() {
    if (!getNotifPrefs().sound) return;
    try {
      var Ctx = window.AudioContext || window.webkitAudioContext;
      if (!Ctx) return;
      var ctx = new Ctx();
      var o = ctx.createOscillator(), g = ctx.createGain();
      o.type = 'sine'; o.frequency.value = 880;
      o.connect(g); g.connect(ctx.destination);
      g.gain.setValueAtTime(0.0001, ctx.currentTime);
      g.gain.exponentialRampToValueAtTime(0.22, ctx.currentTime + 0.02);
      g.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + 0.35);
      o.start(); o.stop(ctx.currentTime + 0.36);
      o.onended = function () { try { ctx.close(); } catch (e) {} };
    } catch (e) {}
  }
  function waAlertUrl(text) {
    var n = String(state.platformWa || '').replace(/\D/g, '');
    return n ? ('https://wa.me/' + n + '?text=' + encodeURIComponent(text)) : '';
  }
  function showSaAlert(title, body, waText) {
    var box = $('saAlert'); if (!box) return;
    $('saAlertTitle').textContent = title;
    $('saAlertBody').textContent = body;
    state.alertWaText = waText || '';
    var p = getNotifPrefs();
    var waBtn = $('saAlertWa');
    if (waBtn) waBtn.classList.toggle('hidden', !(p.whatsapp && waAlertUrl(waText)));
    box.classList.remove('hidden');
    clearTimeout(showSaAlert._t);
    showSaAlert._t = setTimeout(function () { box.classList.add('hidden'); }, 30000);
  }
  function notifySA(kind, data) {
    var title, body, wa;
    var c = (data && data.count) || 1;
    if (kind === 'payment') {
      title = '💰 Novo comprovante de pagamento';
      body = c + ' comprovante(s) aguardando liberação.';
      wa = 'CardapioDigital SaaS: ' + c + ' novo(s) comprovante(s) de pagamento aguardando liberação.';
    } else if (kind === 'lead') {
      title = '🛒 Nova contratação pela página';
      body = c + ' contato(s) novo(s) querendo assinar o SaaS.';
      wa = 'CardapioDigital SaaS: nova contratação de plano recebida pela página de vendas. Confira no painel!';
    } else {
      title = '🏢 Nova loja cadastrada';
      body = 'Uma nova loja entrou na plataforma.';
      wa = 'CardapioDigital SaaS: nova loja cadastrada na plataforma.';
    }
    playBeep();
    var p = getNotifPrefs();
    if (p.desktop && notifPermission() === 'granted') {
      try {
        var n = new Notification(title, { body: body });
        if (p.whatsapp) n.onclick = function () { window.focus(); var u = waAlertUrl(wa); if (u) window.open(u, '_blank', 'noopener'); };
      } catch (e) {}
    }
    showSaAlert(title, body, wa);
    toast(title);
  }
  function evaluateNotifications(s) {
    var pend = Number(s.pendingPayments || 0);
    var total = Number((s.tenants || {}).total || 0);
    var leads = Number(s.newLeads || 0);
    if (!state.notify.booted) {
      state.notify.booted = true;
      state.notify.pending = pend;
      state.notify.tenants = total;
      state.notify.leads = leads;
      return;
    }
    if (pend > state.notify.pending) notifySA('payment', { count: pend - state.notify.pending });
    if (leads > state.notify.leads) notifySA('lead', { count: leads - state.notify.leads });
    if (total > state.notify.tenants) notifySA('tenant', { count: total - state.notify.tenants });
    state.notify.pending = pend;
    state.notify.tenants = total;
    state.notify.leads = leads;
  }
  function startNotifyPolling() {
    stopNotifyPolling();
    state.notify.timer = setInterval(function () {
      if (!state.token) { stopNotifyPolling(); return; }
      loadStats();
    }, 25000);
  }
  function stopNotifyPolling() {
    if (state.notify.timer) { clearInterval(state.notify.timer); state.notify.timer = null; }
  }

  /* ------------------- login ------------------- */
  async function login() {
    var email = ($('saEmail').value || '').trim();
    var pass = $('saPass').value || '';
    var err = $('saLoginErr');
    err.textContent = '';
    if (!email || !pass) { err.textContent = 'Informe e-mail e senha'; return; }
    var btn = $('saLoginBtn');
    btn.disabled = true; btn.textContent = 'Entrando…';
    var res = await api('POST', '/api/super-admin/login', { email: email, password: pass });
    btn.disabled = false; btn.textContent = 'Entrar no Painel Super Admin';
    if (!res.ok || !res.token) {
      err.textContent = 'Credenciais de Super Admin inválidas. Esta área é restrita ao gestor geral da plataforma SaaS.';
      return;
    }
    setToken(res.token);
    showDash(res.user);
    var pl = await api('GET', '/api/super-admin/plans');
    if (pl.ok) state.plans = pl.plans || [];
    state.notify.booted = false;
    await loadSupport();
    await refreshAll();
    startNotifyPolling();
    await ensureMsgData();
    await loadRevenue();
  }

  /* ------------------- aparência (aba Configurações) ------------------- */
  var APPEAR_KEY = 'super_admin_appearance';
  function hexToRgb(hex) {
    var m = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex || '');
    return m ? { r: parseInt(m[1], 16), g: parseInt(m[2], 16), b: parseInt(m[3], 16) } : { r: 124, g: 58, b: 237 };
  }
  function shade(hex, pct) {
    var c = hexToRgb(hex);
    function f(v) { return Math.max(0, Math.min(255, Math.round(v + (pct < 0 ? v : 255 - v) * pct))); }
    return '#' + [f(c.r), f(c.g), f(c.b)].map(function (v) { return ('0' + v.toString(16)).slice(-2); }).join('');
  }
  function getAppearance() {
    var saved = {};
    try { saved = JSON.parse(localStorage.getItem(APPEAR_KEY) || '{}') || {}; } catch (e) {}
    return { color: saved.color || '#7c3aed', theme: saved.theme || 'light' };
  }
  function saveAppearance(a) { try { localStorage.setItem(APPEAR_KEY, JSON.stringify(a)); } catch (e) {} }
  function applyAppearance(a) {
    a = a || getAppearance();
    var root = document.documentElement;
    root.style.setProperty('--primary', a.color);
    root.style.setProperty('--primary-dark', shade(a.color, -0.18));
    root.style.setProperty('--accent', shade(a.color, 0.35));
    root.setAttribute('data-theme', a.theme === 'dark' ? 'dark' : 'light');
    var seg = $('themeSeg');
    if (seg) seg.querySelectorAll('button').forEach(function (b) { b.classList.toggle('active', b.dataset.theme === a.theme); });
    var sw = $('swatches');
    if (sw) sw.querySelectorAll('.swatch').forEach(function (b) { if (b.dataset.color) b.classList.toggle('active', b.dataset.color.toLowerCase() === a.color.toLowerCase()); });
    var inp = $('accColor'); if (inp) inp.value = a.color;
  }
  function setAppearance(patch) {
    var a = getAppearance();
    if (patch.color) a.color = patch.color;
    if (patch.theme) a.theme = patch.theme;
    saveAppearance(a);
    applyAppearance(a);
  }

  /* ------------------- conta do super-admin (aba Configurações) ------------------- */
  async function loadSupport() {
    var r = await api('GET', '/api/super-admin/templates');
    if (!r.ok) return;
    state.platformWa = String(r.support_whatsapp || '').replace(/\D/g, '');
    if (r.pix_key !== undefined) state.pixKey = r.pix_key || '';
    if (r.pix_name !== undefined) state.pixName = r.pix_name || '';
    if ($('saSupportWa')) $('saSupportWa').value = r.support_whatsapp || '';
  }
  async function saveSupport() {
    var err = $('saSupportErr'); err.textContent = '';
    var digits = String($('saSupportWa').value || '').replace(/\D/g, '');
    if (digits && (digits.length < 12 || digits.length > 15)) {
      err.textContent = 'Informe com DDI + DDD + número (ex.: 5585999999999)';
      return;
    }
    var r = await api('PUT', '/api/super-admin/templates', { support_whatsapp: digits });
    if (!r.ok) { err.textContent = r.error || 'Falha ao salvar'; return; }
    $('saSupportWa').value = digits;
    state.platformWa = digits;
    updateNotifUI();
    toast('WhatsApp da plataforma atualizado');
  }
  async function loadAccount() {
    var r = await api('GET', '/api/super-admin/account');
    if (!r.ok || !r.account) return;
    var a = r.account;
    if ($('accName')) $('accName').value = a.name || '';
    if ($('accEmail')) $('accEmail').value = a.email || '';
    if ($('accMeta')) $('accMeta').textContent = 'Conta criada em ' + dt(a.created_at) + ' · perfil super-admin';
  }
  async function saveAccount() {
    var err = $('accErr'); err.textContent = '';
    var body = {
      name: ($('accName').value || '').trim(),
      email: ($('accEmail').value || '').trim().toLowerCase()
    };
    if (!body.email) { err.textContent = 'Informe um e-mail válido'; return; }
    var r = await api('PUT', '/api/super-admin/account', body);
    if (!r.ok) { err.textContent = r.error || 'Falha ao salvar'; return; }
    var me = r.account || body;
    var w = $('whoami'); if (w) w.textContent = me.email || me.name || 'super-admin';
    toast('Dados da conta atualizados');
  }
  async function changePassword() {
    var err = $('pwErr'); err.textContent = '';
    var cur = $('pwCurrent').value, nw = $('pwNew2').value, cf = $('pwConfirm').value;
    if (!cur) { err.textContent = 'Informe a senha atual'; return; }
    if (nw.length < 8) { err.textContent = 'A nova senha deve ter ao menos 8 caracteres'; return; }
    if (nw !== cf) { err.textContent = 'A confirmação não confere'; return; }
    var r = await api('PUT', '/api/super-admin/account/password', { current: cur, password: nw });
    if (!r.ok) { err.textContent = r.error || 'Falha ao alterar senha'; return; }
    $('pwCurrent').value = ''; $('pwNew2').value = ''; $('pwConfirm').value = '';
    toast('Senha alterada com sucesso');
  }

  /* ------------------- boot ------------------- */
  document.addEventListener('DOMContentLoaded', function () {
    var form = $('loginForm');
    if (form) form.addEventListener('submit', function (e) { e.preventDefault(); login(); });
    var _tgl = $('btnAdminToggle');
    if (_tgl) _tgl.onclick = function () { var sb = $('admin-sidebar'); if (sb) sb.classList.toggle('open'); };
    $('saLoginBtn').onclick = function (e) { e.preventDefault(); login(); };
    $('saLogout').onclick = function () { stopNotifyPolling(); setToken(''); showLogin(); };

    /* Configurações: conta, senha e aparência */
    if ($('accSave')) $('accSave').onclick = saveAccount;
    if ($('saSupportSave')) $('saSupportSave').onclick = saveSupport;
    if ($('pwChange')) $('pwChange').onclick = changePassword;
    if ($('swatches')) $('swatches').addEventListener('click', function (e) {
      var sw = e.target.closest('.swatch');
      if (sw && sw.dataset.color) setAppearance({ color: sw.dataset.color });
    });
    if ($('accColor')) $('accColor').addEventListener('input', function () { setAppearance({ color: this.value }); });
    if ($('themeSeg')) $('themeSeg').addEventListener('click', function (e) {
      var b = e.target.closest('button[data-theme]');
      if (b) setAppearance({ theme: b.dataset.theme });
    });
    if ($('appearanceReset')) $('appearanceReset').onclick = function () {
      saveAppearance({ color: '#7c3aed', theme: 'light' });
      applyAppearance();
      toast('Aparência restaurada ao padrão');
    };
    applyAppearance();

    /* Notificações (navegador / som / WhatsApp) */
    updateNotifUI();
    if ($('notifDesktop')) $('notifDesktop').onchange = function () {
      saveNotifPrefs({ desktop: this.checked });
      if (this.checked) requestNotifPerm();
    };
    if ($('notifSound')) $('notifSound').onchange = function () { saveNotifPrefs({ sound: this.checked }); if (this.checked) playBeep(); };
    if ($('notifWhatsapp')) $('notifWhatsapp').onchange = function () { saveNotifPrefs({ whatsapp: this.checked }); };
    if ($('notifPermBtn')) $('notifPermBtn').onclick = requestNotifPerm;
    if ($('saAlertClose')) $('saAlertClose').onclick = function () { $('saAlert').classList.add('hidden'); };
    if ($('saAlertWa')) $('saAlertWa').onclick = function () {
      var u = waAlertUrl(state.alertWaText);
      if (u) window.open(u, '_blank', 'noopener');
    };

    document.querySelectorAll('#tabs button').forEach(function (b) {
      b.onclick = function () { switchTab(b.dataset.tab); };
    });
    $('btnPending').onclick = function () { switchTab('notifications'); };
    $('payBannerBtn').onclick = function () { switchTab('notifications'); };
    $('btnNew').onclick = function () { $('newErr').textContent = ''; openModal('modalNew'); };
    $('btnCreate').onclick = createTenant;
    $('nName').addEventListener('input', function () {
      if (!$('nSub').value) $('nSub').value = slugify($('nName').value);
      previewSubdomain();
    });
    $('nSub').addEventListener('input', function () {
      previewSubdomain();
    });
    $('nSub').addEventListener('blur', function () {
      $('nSub').value = slugify($('nSub').value);
      previewSubdomain();
    });
    var subdomainCheck;
    function previewSubdomain() {
      var value = slugify($('nSub').value);
      $('slugPreview').textContent = value ? 'Link da loja: /?tenant=' + value + ' · verificando disponibilidade…' : 'Informe um nome para gerar o endereço da loja.';
      clearTimeout(subdomainCheck);
      if (!value) return;
      subdomainCheck = setTimeout(async function () {
        var result = await api('GET', '/api/super-admin/tenants/check-subdomain?value=' + encodeURIComponent(value));
        if ($('nSub').value.trim().toLowerCase() !== value) return;
        $('slugPreview').textContent = result.ok
          ? (result.available ? '✓ Endereço disponível: /?tenant=' + value : '✕ ' + (result.error || result.message))
          : (result.error || 'Não foi possível verificar o endereço');
        $('slugPreview').style.color = result.ok && result.available ? 'var(--ok)' : 'var(--bad)';
      }, 350);
    }

    document.querySelectorAll('[data-close]').forEach(function (b) {
      b.onclick = function () {
        var m = b.closest('.modal');
        if (m) m.classList.add('hidden');
        if (m && m.id === 'modalSecret') {
          state.lastCreated = null;
          state.waCtx = null;
          $('secBox').textContent = '';
        }
      };
    });
    document.querySelectorAll('.modal').forEach(function (m) {
      m.addEventListener('click', function (e) {
        if (e.target !== m) return;
        m.classList.add('hidden');
        if (m.id === 'modalSecret') {
          state.lastCreated = null;
          state.waCtx = null;
          $('secBox').textContent = '';
        }
      });
    });

    var debounce;
    $('q').addEventListener('input', function () { clearTimeout(debounce); debounce = setTimeout(function () { loadTenants(); }, 300); });
    $('fStatus').onchange = function () { loadTenants(); };
    $('fPlan').onchange = function () { loadTenants(); };
    $('tbody').addEventListener('click', function (e) {
      var btn = e.target.closest('button[data-act]');
      if (btn) rowAction(btn);
    });

    $('payFilter').onchange = loadPayments;
    $('payReload').onclick = loadPayments;
    $('payList').addEventListener('click', function (e) {
      var btn = e.target.closest('button[data-pay]');
      if (btn) payAction(btn);
    });

    if ($('leadFilter')) $('leadFilter').onchange = loadLeads;
    if ($('leadReload')) $('leadReload').onclick = loadLeads;
    if ($('leadList')) $('leadList').addEventListener('click', function (e) {
      var btn = e.target.closest('button[data-lead]');
      if (btn) leadAction(btn);
    });

    if ($('subFilter')) $('subFilter').onchange = loadSubs;
    if ($('subReload')) $('subReload').onclick = loadSubs;
    if ($('subList')) $('subList').addEventListener('click', function (e) {
      var btn = e.target.closest('button[data-sub]');
      if (btn) subAction(btn);
    });

    document.addEventListener('click', function (e) {
      var sv = e.target.closest('button[data-saveplan]');
      if (sv) savePlan(sv.dataset.saveplan);
      var pk = e.target.closest('button[data-pick]');
      if (pk && state.planCtx) {
        state.planCtx.selected = pk.dataset.pick;
        document.querySelectorAll('#planPick button').forEach(function (b) {
          b.classList.toggle('sel', b.dataset.pick === state.planCtx.selected);
        });
        var diff = state.planCtx.selected !== state.planCtx.current;
        $('planConfirm').disabled = !diff;
        if (diff) {
          $('planWarn').textContent = '⚠️ A loja será migrada de ' + planLabel(state.planCtx.current) + ' para ' + planLabel(state.planCtx.selected) + ' (' + brl(planPrice(state.planCtx.selected)) + '/mês). Deseja confirmar?';
          $('planWarn').classList.remove('hidden');
        } else $('planWarn').classList.add('hidden');
      }
      var tg = e.target.closest('button[data-tag]');
      if (tg) {
        var ta = $('msgText');
        var s = ta.selectionStart || ta.value.length;
        ta.value = ta.value.slice(0, s) + tg.dataset.tag + ta.value.slice(ta.selectionEnd || s);
        ta.focus(); renderMsgPreview();
      }
    });
    $('planConfirm').onclick = confirmPlan;
    $('suspConfirm').onclick = confirmSuspend;

    $('msgTenant').onchange = renderMsgPreview;
    $('msgModel').onchange = function () { $('msgText').dataset.model = ''; renderMsgPreview(); };
    $('msgText').addEventListener('input', function () { $('msgPreview').textContent = compileTpl($('msgText').value, currentMsgCtx()); });
    $('pixKey').addEventListener('input', function () { state.pixKey = $('pixKey').value; renderMsgPreview(); });
    $('pixName').addEventListener('input', function () { state.pixName = $('pixName').value; renderMsgPreview(); });
    $('msgCopy').onclick = async function () {
      try { await navigator.clipboard.writeText($('msgPreview').textContent); toast('Copiado!'); }
      catch (e) { toast('Não foi possível copiar'); }
    };
    $('msgSend').onclick = async function () {
      var ctx = await buildCtx($('msgTenant').value, {});
      var text = compileTpl($('msgText').value, ctx || currentMsgCtx());
      window.open(waLink(ctx && ctx.tenant.phone, text), '_blank', 'noopener');
    };
    $('msgSave').onclick = async function () {
      var body = { templates: {}, pix_key: $('pixKey').value, pix_name: $('pixName').value };
      body.templates[$('msgModel').value] = $('msgText').value;
      var r = await api('PUT', '/api/super-admin/templates', body);
      if (r.ok) { state.templates[$('msgModel').value] = $('msgText').value; state.pixKey = $('pixKey').value; state.pixName = $('pixName').value; toast('Modelos salvos'); }
      else toast(r.error || 'Falha ao salvar');
    };
    $('msgRestore').onclick = function () {
      var m = $('msgModel').value;
      if (ORIG_TEMPLATES[m]) { $('msgText').value = ORIG_TEMPLATES[m]; renderMsgPreview(); toast('Modelo restaurado (salve para persistir)'); }
    };

    $('secWa').onclick = async function () {
      var c = state.lastCreated; if (!c) { closeModal('modalSecret'); return; }
      closeModal('modalSecret');
      state.tenantMap[c.tenant.id] = Object.assign({ orders30d: 0, revenue30d: 0 }, c.tenant);
      var ctx = await buildCtx(c.tenant.id, { password: c.adminPassword });
      state.waCtx = ctx;
      $('waWho').textContent = 'Loja: ' + c.tenant.name + ' (/' + c.tenant.subdomain + ')';
      $('waModel').value = 'onboarding';
      $('waPass').value = c.adminPassword;
      renderWaPreview();
      openModal('modalWa');
    };
    $('secCopy').onclick = async function () {
      var c = state.lastCreated;
      if (!c) return;
      var text = 'Loja: ' + c.tenant.name + '\nCardápio: ' + location.origin + '/?tenant=' + c.tenant.subdomain
        + '\nE-mail: ' + c.adminEmail + '\nSenha inicial: ' + c.adminPassword;
      try {
        await navigator.clipboard.writeText(text);
        toast('Dados de acesso copiados');
      } catch (e) {
        toast('Não foi possível copiar os dados');
      }
    };
    $('waModel').onchange = renderWaPreview;
    $('waPass').addEventListener('input', renderWaPreview);
    $('waCopy').onclick = async function () {
      try { await navigator.clipboard.writeText($('waPreview').textContent); toast('Copiado!'); }
      catch (e) { toast('Não foi possível copiar'); }
    };
    $('waSend').onclick = function () {
      if (!state.waCtx) return;
      window.open(waLink(state.waCtx.tenant.phone, $('waPreview').textContent), '_blank', 'noopener');
    };

    $('pwGen').onclick = genPassword;
    $('pwCopy').onclick = async function () {
      try { await navigator.clipboard.writeText($('pwMsg').textContent); toast('Copiado!'); }
      catch (e) { toast('Não foi possível copiar'); }
    };
    $('pwSend').onclick = function () {
      if (!state.pwCtx || !state.pwCtx.pwMsg) return;
      window.open(waLink(state.pwCtx.tenant.phone, state.pwCtx.pwMsg), '_blank', 'noopener');
    };

    if ($('auditClear')) $('auditClear').onclick = clearAudit;

    /* Segurança: NUNCA entra sem credenciais. Ao abrir a página, descarta
       qualquer token salvo e exige login novamente. */
    setToken('');
    showLogin();
  });
})();
