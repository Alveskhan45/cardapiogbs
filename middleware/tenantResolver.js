// @ts-check
/* ============================================================
   middleware/tenantResolver.js — Fase 2 do plano

   Descobre QUAL tenant a requisição é. Ordem de resolução:
     1. subdomínio   (cliente.seusaas.com) — exige WILDCARD_DOMAIN
     2. header        (X-Tenant-ID)
     3. query        (?tenant=slug)
     4. path         (/t/slug/...)

   Com TENANT_RESOLVER=auto (default) usa todas em ordem.
   Com TENANT_STRICT=1 usa apenas a fonte indicada em TENANT_RESOLVER.

   Deixa req.tenant e req.tenantId prontos. As queries do app rodam
   com esse id (db/index.js → runTenant), então a RLS do Postgres
   garante que nada de outro tenant entre na resposta.
   ============================================================ */
'use strict';

const db = require('../db');

/**
 * Tenant resolvido (formato vindo do banco).
 * @typedef {Object} Tenant
 * @property {string} id
 * @property {string} name
 * @property {string} subdomain
 * @property {string} [slug]
 * @property {string} plan
 * @property {'active' | 'trial' | 'pending_approval' | 'suspended' | 'cancelled'} status
 * @property {Record<string, unknown>} settings
 * @property {Date | string} created_at
 * @property {Date | string | null} [trial_ends_at]
 * @property {Date | string | null} [subscription_expires_at]
 */

/**
 * Subconjunto de req usado pelo resolver (evita depender do tipo do Express).
 * @typedef {Object} ResolverRequest
 * @property {(name: string) => string | undefined} get
 * @property {Record<string, string>} query
 * @property {string} path
 * @property {string} baseUrl
 * @property {Tenant} [tenant]
 * @property {string} [tenantId]
 * @property {string} [tenantIdentifier]
 */

/**
 * Resposta mínima usada nos caminhos de erro do resolver.
 * @typedef {Object} ResolverResponse
 * @property {(status: number) => ResolverResponse} status
 * @property {(body: unknown) => void} json
 */

const IDENT_RE = /^[a-z0-9][a-z0-9-]{0,98}[a-z0-9]$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const CACHE_TTL_MS = 60 * 1000;
/** @type {Map<string, { tenant: Tenant, at: number }>} */
const cache = new Map();

/**
 * Normaliza um identificador de tenant (UUID passa intacto; slug vai a minúsculo).
 * @param {unknown} v valor cru (header, query, path)
 * @returns {string | null} identificador válido ou null
 */
function normalize(v) {
  const s = String(v || '').trim();
  if (!s) return null;
  const lower = s.toLowerCase();
  if (UUID_RE.test(s)) return s;
  return IDENT_RE.test(lower) ? lower : null;
}

/* Rota que pode responder SEM tenant (Fase 2.2 do plano).
   ATENÇÃO: dentro de app.use('/api', ...) o req.path vem sem o prefixo
   '/api' — por isso montamos o caminho completo com baseUrl. */
/**
 * Caminho completo da rota (baseUrl + path).
 * @param {ResolverRequest} req
 * @returns {string}
 */
function fullPath(req) {
  return (req.baseUrl || '') + (req.path || '');
}

/**
 * Rotas que respondem sem tenant (health, super-admin, público).
 * @param {string} pathname
 * @returns {boolean}
 */
function isTenantlessRoute(pathname) {
  if (pathname === '/api/health' || pathname === '/api/ready' || pathname === '/health') return true;
  /* Webhooks vêm dos provedores (Stripe/Asaas) sem subdomínio de loja. O
     tenant é resolvido depois, pelo subscription_id do evento, via pool de
     superusuário — exigir tenant aqui rejeitaria todo pagamento. */
  if (pathname.startsWith('/api/webhooks/')) return true;
  if (pathname.startsWith('/api/super-admin/')) return true;
  if (pathname.startsWith('/api/public/tenant/')) return true;
  if (pathname === '/api/public/plans') return true;
  if (pathname === '/api/public/leads') return true;
  if (pathname === '/api/public/signup') return true;
  if (pathname.startsWith('/api/public/contract/')) return true;
  return false;
}

/**
 * Extrai o subdomínio do host quando ele termina em .WILDCARD_DOMAIN.
 * @param {string | undefined} hostname
 * @returns {string | null}
 */
function subdomainFromHost(hostname) {
  const base = String(process.env.WILDCARD_DOMAIN || '').trim().toLowerCase();
  const host = String(hostname || '').split(':')[0].toLowerCase();
  if (!base || !host) return null;
  if (host === base) return null;
  if (!host.endsWith('.' + base)) return null;
  return normalize(host.slice(0, -(base.length + 1)));
}

/**
 * Lista os identificadores candidatos, na ordem de prioridade.
 * @param {ResolverRequest} req
 * @returns {string[]}
 */
function candidateIdentifiers(req) {
  const mode = String(process.env.TENANT_RESOLVER || 'auto').toLowerCase();
  const strict = String(process.env.TENANT_STRICT || '0') === '1';

  if (strict && mode !== 'auto') {
    /* filter(Boolean) remove null/undefined: ramo strict não pode
       devolver candidato vazio (senão o resolver consultaria com null). */
    if (mode === 'subdomain') {
      return /** @type {string[]} */ ([subdomainFromHost(req.get('host'))].filter(Boolean));
    }
    if (mode === 'header') {
      return /** @type {string[]} */ ([normalize(req.get('x-tenant-id'))].filter(Boolean));
    }
    if (mode === 'path') {
      return /** @type {string[]} */ ([normalize((req.path.match(/^\/t\/([^/]+)/) || [])[1])].filter(Boolean));
    }
    return [];
  }

  /** @type {(string | null)[]} */
  const all = [
    subdomainFromHost(req.get('host')),
    normalize(req.get('x-tenant-id')),
    normalize(req.query && req.query.tenant),
    normalize((req.path.match(/^\/t\/([^/]+)/) || [])[1])
  ];
  return /** @type {string[]} */ (all.filter(Boolean));
}

/**
 * Busca o tenant no cache (TTL 60s) ou no banco, aplicando a expiração
 * de trial/assinatura. `pending_approval` nunca expira.
 * @param {string} identifier
 * @returns {Promise<Tenant | null>}
 */
async function lookupTenant(identifier) {
  const hit = cache.get(identifier);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) {
    let expiresAt = null;
    if (hit.tenant.status === 'trial') {
      expiresAt = hit.tenant.trial_ends_at || new Date(new Date(hit.tenant.created_at).getTime() + 14 * 24 * 60 * 60 * 1000);
    } else if (hit.tenant.status === 'active') {
      expiresAt = hit.tenant.subscription_expires_at;
    }
    // pending_approval não expira
    if (!expiresAt || new Date(expiresAt).getTime() > Date.now()) return hit.tenant;
    cache.delete(identifier);
    return null;
  }

  const r = await db.queryApp(
    `SELECT id, name, subdomain, slug, plan, status, settings, created_at,
            trial_ends_at, subscription_expires_at
     FROM tenants
     WHERE (id::text = $1 OR subdomain = $1 OR slug = $1)
       AND deleted_at IS NULL
       AND (
         (status = 'active' AND (subscription_expires_at IS NULL OR subscription_expires_at > NOW()))
         OR          (status = 'trial' AND COALESCE(trial_ends_at, created_at + INTERVAL '14 days') > NOW())
         OR          (status = 'pending_approval')
       )
     LIMIT 1`,
    [identifier]
  );
  if (!r.rows.length) return null;

  const tenant = r.rows[0];
  cache.set(identifier, { tenant, at: Date.now() });
  return tenant;
}

/**
 * Limpa o cache de tenants (um identificador ou todos).
 * @param {string} [identifier]
 * @returns {void}
 */
function invalidateTenantCache(identifier) {
  if (!identifier) {
    cache.clear();
    return;
  }
  cache.delete(String(identifier).toLowerCase());
}

/* Em desenvolvimento não há subdomínio: se existir UMA única loja ativa,
   usamos ela como padrão para que http://localhost:3001 funcione direto.
   Em produção (NODE_ENV=production) nunca: o tenant tem que ser explícito. */
/**
 * Fallback de desenvolvimento: usa a loja única quando só existe uma.
 * Em produção ou com DEV_TENANT_FALLBACK=0, nunca.
 * @returns {Promise<Tenant | null>}
 */
async function singleActiveTenant() {
  if (String(process.env.NODE_ENV || '').toLowerCase() === 'production') return null;
  if (String(process.env.DEV_TENANT_FALLBACK || '1') === '0') return null;
  const r = await db.queryApp(
    `SELECT id, name, subdomain, slug, plan, status, settings, created_at,
            trial_ends_at, subscription_expires_at
     FROM tenants
     WHERE deleted_at IS NULL
       AND (
         (status = 'active' AND (subscription_expires_at IS NULL OR subscription_expires_at > NOW()))
         OR          (status = 'trial' AND COALESCE(trial_ends_at, created_at + INTERVAL '14 days') > NOW())
         OR          (status = 'pending_approval')
       )
     ORDER BY created_at LIMIT 2`
  );
  return r.rows.length === 1 ? r.rows[0] : null;
}

/**
 * Middleware Express: resolve o tenant e injeta em req.
 * @param {ResolverRequest} req
 * @param {ResolverResponse} res
 * @param {() => void} next
 * @returns {Promise<void>}
 */
async function tenantResolver(req, res, next) {
  const identifiers = candidateIdentifiers(req);
  const routePath = fullPath(req);

  if (!identifiers.length) {
    if (isTenantlessRoute(routePath)) return next();

    const unico = await singleActiveTenant().catch(() => null);
    if (unico) {
      req.tenant = unico;
      req.tenantId = unico.id;
      req.tenantIdentifier = unico.subdomain;
      return next();
    }

    return res.status(400).json({
      ok: false,
      code: 'TENANT_REQUIRED',
      error: 'Não foi possível identificar a loja. Abra com ?tenant=subdominio ou entre pelo painel da plataforma.'
    });
  }

  try {
    let tenant = null;
    let used = null;
    for (const id of identifiers) {
      tenant = await lookupTenant(id);
      if (tenant) { used = id; break; }
    }

    if (!tenant) {
      if (isTenantlessRoute(routePath)) return next();
      // 404 (não 400): tenant inexistente é erro de endereço, não de request
      return res.status(404).json({ ok: false, code: 'TENANT_NOT_FOUND', error: 'Tenant não encontrado ou inativo' });
    }

    req.tenant = tenant;
    req.tenantId = tenant.id;
    req.tenantIdentifier = used || undefined;
    next();
  } catch (e) {
    console.error('[tenantResolver]', e instanceof Error ? e.message : String(e));
    res.status(500).json({ ok: false, error: 'Erro ao resolver tenant' });
  }
}

module.exports = { tenantResolver, invalidateTenantCache, normalize, candidateIdentifiers };
