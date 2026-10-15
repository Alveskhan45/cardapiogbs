// @ts-check
/* ============================================================
   lib/logger.js — log estruturado (JSON) para observabilidade

   Regras do casa:
   - Uma linha JSON por evento: sempre parseável por agregador
     (journald, Loki, CloudWatch, Datadog...).
   - `request_id` em todo log de request/erro: é o que permite
     correlacionar o erro do usuário com a linha do log.
   - Nunca vazar segredo: redação RECURSIVA por nome de campo.
   - Nível controlado por LOG_LEVEL (debug|info|warn|error).
   ============================================================ */
'use strict';

const LEVELS = ['debug', 'info', 'warn', 'error'];

/**
 * Chaves cujo valor NUNCA deve ir para o log (comparação em minúsculo,
 * sem separadores: 'password_hash' e 'passwordHash' casam igual).
 * @type {Set<string>}
 */
const SENSITIVE_KEYS = new Set([
  'password', 'passwordhash', 'senha', 'senhaatual', 'novasenha',
  'old', 'new', 'current', 'newpassword', 'oldpassword',
  'token', 'accesstoken', 'refreshtoken', 'x-token', 'xtoken',
  'authorization', 'auth', 'jwt', 'secret', 'jwtsecret',
  'cookie', 'set-cookie', 'session',
  'accesscode', 'signuptoken', 'ticket',
  'card', 'cardnumber', 'cvv', 'cpf', 'cnpj',
  'databaseurl', 'superadmindatabaseurl', 'redisurl'
]);

/* (removido) REQUEST_KEYS: a lista de correlação ficou implícita —
   só SENSITIVE_KEYS decide o que é redigido; o resto passa. */

/**
 * Forma de um erro já normalizado para o log.
 * @typedef {Object} ErrorShape
 * @property {string} message
 * @property {string} [error_name]
 * @property {string} [cause_message]
 * @property {string} [stack]
 */

/**
 * @param {string} key
 * @returns {string} chave sem separadores, em minúsculo
 */
function normalizeKey(key) {
  return String(key).toLowerCase().replace(/[^a-z0-9]/g, '');
}

/** @param {unknown} value @returns {unknown} */
function redact(value) {
  if (typeof value === 'string') {
    if (value.length <= 4) return '***';
    return `${value.slice(0, 2)}***${value.slice(-2)}`;
  }
  if (value === null || value === undefined) return value;
  return '[redigido]';
}

/**
 * Redação recursiva: percorre objetos e arrays em profundidade,
 * para não vazar segredo aninhado (ex.: body.user.password).
 * Detecta referências circulares e limita a profundidade.
 * @param {unknown} value
 * @param {number} [depth]
 * @param {WeakSet<object>} [seen]
 * @returns {unknown}
 */
function redactDeep(value, depth = 0, seen = new WeakSet()) {
  if (value === null || typeof value !== 'object') return value;
  if (depth > 6) return '[profundidade maxima]';
  if (seen.has(value)) return '[circular]';
  seen.add(value);
  if (Array.isArray(value)) return value.map(v => redactDeep(v, depth + 1, seen));
  if (value instanceof Date) return value.toISOString();
  if (value instanceof Error) return describeError(value);
  /** @type {Record<string, unknown>} */
  const out = {};
  for (const [k, v] of Object.entries(value)) {
    out[k] = SENSITIVE_KEYS.has(normalizeKey(k)) ? redact(v) : redactDeep(v, depth + 1, seen);
  }
  return out;
}

/** @param {unknown} obj @returns {string} */
function stringify(obj) {
  const seen = new WeakSet();
  return JSON.stringify(obj, (_k, v) => {
    if (typeof v === 'bigint') return String(v);
    if (typeof v === 'function') return '[funcao]';
    if (typeof v === 'object' && v !== null) {
      if (seen.has(v)) return '[circular]';
      seen.add(v);
    }
    return v;
  });
}

/** @param {string} level @returns {boolean} */
function levelEnabled(level) {
  const configured = String(process.env.LOG_LEVEL || (process.env.NODE_ENV === 'production' ? 'info' : 'debug'))
    .trim()
    .toLowerCase();
  const threshold = LEVELS.includes(configured) ? LEVELS.indexOf(configured) : LEVELS.indexOf('debug');
  return LEVELS.indexOf(level) >= threshold;
}

function now() {
  return new Date().toISOString();
}

/**
 * Normaliza qualquer coisa em { message, ... } para o log.
 * @param {unknown} err
 * @returns {ErrorShape}
 */
function describeError(err) {
  if (err instanceof Error) {
    return {
      message: err.message,
      error_name: err.name,
      ...(err.cause ? { cause_message: describeError(err.cause).message } : {}),
      stack: levelEnabled('debug') ? err.stack : undefined
    };
  }
  if (typeof err === 'string') return { message: err };
  return { message: String(err) };
}

/**
 * Emite um evento estruturado.
 * @param {'debug'|'info'|'warn'|'error'} level
 * @param {string} event nome estável do evento (snake_case)
 * @param {Record<string, unknown> | Error} [details]
 */
function emit(level, event, details = {}) {
  if (!LEVELS.includes(level) || !levelEnabled(level)) return;
  /* Error passado direto como details: normaliza (Object.entries de Error
     é vazio — sem isso o evento sairia sem mensagem nem stack). */
  const payload = details instanceof Error ? describeError(details) : details;
  const line = stringify({
    ts: now(),
    level,
    event,
    .../** @type {Record<string, unknown>} */ (redactDeep(payload))
  });
  if (level === 'error') console.error(line);
  else if (level === 'warn') console.warn(line);
  else console.log(line);
}

/**
 * Mínimo de req/res necessário para logar um erro de rota.
 * @typedef {Object} LogRequest
 * @property {string} [method]
 * @property {string} [path]
 * @property {string} [requestId]
 * @property {string} [tenantId]
 * @property {{ subdomain?: string }} [tenant]
 */

/**
 * @typedef {Object} LogResponse
 * @property {number} statusCode
 */

/** Registra um erro de rota já com o contexto do request. */
/**
 * @param {LogRequest} req
 * @param {string} route
 * @param {unknown} err
 */
function routeError(req, route, err) {
  const { message, error_name: errorName, stack, cause_message: causeMessage } = describeError(err);
  emit('error', 'http_error', {
    route,
    method: req && req.method,
    request_id: req && req.requestId ? req.requestId : null,
    tenant_id: req && req.tenantId ? req.tenantId : null,
    tenant: req && req.tenant && req.tenant.subdomain ? req.tenant.subdomain : null,
    status: 500,
    error_name: errorName,
    message,
    ...(causeMessage ? { cause_message: causeMessage } : {}),
    ...(stack ? { stack } : {})
  });
}

/**
 * Linha de acesso: classifica por status (5xx erro, 4xx warn, 2xx info).
 * @param {LogRequest & { get?: (n: string) => string | undefined, originalUrl?: string, ip?: string }} req
 * @param {LogResponse} res
 * @param {number} startedAt epoch ms do início
 */
function request(req, res, startedAt) {
  const status = res && res.statusCode ? res.statusCode : 500;
  const rawPath = (req && (req.originalUrl || req.path)) || '';
  const path = rawPath.split('?')[0];
  const details = {
    request_id: req && req.requestId ? req.requestId : null,
    method: req && req.method ? req.method : 'UNKNOWN',
    path,
    route: `${req && req.method} ${path}`,
    status,
    status_class: `${Math.floor(status / 100)}xx`,
    tenant_id: req && req.tenantId ? req.tenantId : null,
    tenant: req && req.tenant && req.tenant.subdomain ? req.tenant.subdomain : null,
    ip: req && req.ip ? req.ip : null,
    duration_ms: Date.now() - startedAt,
    user_agent: req && req.get ? req.get('user-agent') : null
  };
  if (status >= 500) emit('error', 'http_request', details);
  else if (status >= 400) emit('warn', 'http_request', details);
  else emit('info', 'http_request', details);
}

module.exports = {
  /** @param {string} event @param {Record<string, unknown>} [details] */
  debug(event, details) { emit('debug', event, details); },
  /** @param {string} event @param {Record<string, unknown>} [details] */
  info(event, details) { emit('info', event, details); },
  /** @param {string} event @param {Record<string, unknown>} [details] */
  warn(event, details) { emit('warn', event, details); },
  /** @param {string} event @param {Record<string, unknown> | Error} [details] */
  error(event, details) { emit('error', event, details); },
  request,
  routeError,
  // expostos para permitir asserção em teste
  _internals: { redactDeep, describeError, stringify, levelEnabled }
};
