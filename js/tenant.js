/* ============================================================
   js/tenant.js — detecção de tenant no navegador (Fase 5.1)

   Carregado ANTES de todos os outros scripts. Define qual loja
   o navegador está falando com e injeta o identificador em
   todas as chamadas de API.

   Ordem de resolução:
     1. impersonação (sessionStorage) — painel da plataforma
     2. ?tenant=slug na URL
     3. subdomínio (cliente.seusaas.com)
     4. localStorage 'dev_tenant' (dev local)

   Dev local:  http://localhost:3001/?tenant=legado
   Produção:   https://cliente.seusaas.com
   ============================================================ */
(function () {
  var KEY_DEV = 'dev_tenant';
  var KEY_IMP_TENANT = 'imp_tenant';
  var KEY_IMP_TOKEN = 'imp_token';

  function ls(k) { try { return localStorage.getItem(k); } catch (e) { return null; } }
  function lsSet(k, v) { try { localStorage.setItem(k, v); } catch (e) {} }
  function ss(k) { try { return sessionStorage.getItem(k); } catch (e) { return null; } }
  function ssSet(k, v) { try { sessionStorage.setItem(k, v); } catch (e) {} }

  function clean(v) {
    var s = String(v == null ? '' : v).trim().toLowerCase();
    return /^[a-z0-9][a-z0-9-]{0,98}[a-z0-9]$/.test(s) ? s : '';
  }

  function hostTenant() {
    var host = window.location.hostname || '';
    if (host === 'localhost' || host === '127.0.0.1' || host === '::1') return '';
    var parts = host.split('.');
    // precisa de subdominio + dominio + tld (ex.: cliente.seusaas.com)
    return parts.length >= 3 ? clean(parts[0]) : '';
  }

  function queryTenant() {
    try {
      var m = /[?&]tenant=([^&#]*)/.exec(window.location.search || '');
      return m ? clean(decodeURIComponent(m[1])) : '';
    } catch (e) { return ''; }
  }

  function getCurrentTenant() {
    var imp = clean(ss(KEY_IMP_TENANT));
    if (imp) return imp;
    var q = queryTenant();
    if (q) return q;
    var h = hostTenant();
    if (h) { lsSet(KEY_DEV, h); return h; }
    return clean(ls(KEY_DEV));
  }

  /* true quando esta aba entrou por impersonação do painel da plataforma */
  function isImpersonating() { return !!ss(KEY_IMP_TOKEN); }

  /* Query string para rotas que não aceitam header (EventSource, links) */
  function tenantQuery() {
    var t = getCurrentTenant();
    return t ? '?tenant=' + encodeURIComponent(t) : '';
  }

  /* Todo /api/ passa a carregar o tenant. O wrapper é instalado aqui para
     valer tanto para api() (state.js) quanto para fetch() solto (checkout). */
  if (!window.__TENANT_FETCH_WRAPPED__) {
    window.__TENANT_FETCH_WRAPPED__ = true;
    var originalFetch = window.fetch ? window.fetch.bind(window) : null;
    if (originalFetch) {
      window.fetch = function (input, init) {
        try {
          var url = typeof input === 'string' ? input : (input && input.url) || '';
          var isApi = url.indexOf('/api/') === 0 || url.indexOf('/api?') === 0 || /^(https?:)?\/\/[^/]+\/api\//.test(url);
          if (isApi) {
            var t = getCurrentTenant();
            if (t) {
              init = init || {};
              init.headers = init.headers || {};
              var has = false;
              if (typeof Headers !== 'undefined' && init.headers instanceof Headers) has = init.headers.has('X-Tenant-ID');
              else if (init.headers) has = Object.keys(init.headers).some(function (k) { return k.toLowerCase() === 'x-tenant-id'; });
              if (!has) init.headers['X-Tenant-ID'] = t;
            }
          }
        } catch (e) { /* nunca quebrar a chamada por causa do tenant */ }
        return originalFetch(input, init);
      };
    }
  }

  /* Troca de loja em dev (usado pelo painel da plataforma e por testes manuais) */
  window.setDevTenant = function (slug) {
    var s = clean(slug);
    if (s) lsSet(KEY_DEV, s); else try { localStorage.removeItem(KEY_DEV); } catch (e) {}
    return s;
  };

  window.startImpersonation = function (token, tenant) {
    ssSet(KEY_IMP_TOKEN, token);
    ssSet(KEY_IMP_TENANT, clean(tenant));
    lsSet(KEY_DEV, clean(tenant));
  };

  window.stopImpersonation = function () {
    try { sessionStorage.removeItem(KEY_IMP_TOKEN); sessionStorage.removeItem(KEY_IMP_TENANT); } catch (e) {}
  };

  window.getImpersonationToken = function () { return ss(KEY_IMP_TOKEN) || ''; };

  window.getCurrentTenant = getCurrentTenant;
  window.isImpersonating = isImpersonating;
  window.tenantQuery = tenantQuery;
})();
