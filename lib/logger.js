'use strict';

const LEVELS = ['debug', 'info', 'warn', 'error'];

function now() {
  return new Date().toISOString();
}

function redactValue(value) {
  if (value === null || value === undefined) return value;
  if (typeof value === 'string') {
    if (value.length <= 3) return value;
    return `${value.slice(0, 2)}***${value.slice(-2)}`;
  }
  return value;
}

function sanitize(details = {}) {
  if (!details || typeof details !== 'object') return details;
  const cloned = { ...details };
  for (const key of ['password', 'token', 'authorization', 'secret', 'jwt', 'cookie']) {
    if (Object.prototype.hasOwnProperty.call(cloned, key)) {
      cloned[key] = redactValue(cloned[key]);
    }
  }
  return cloned;
}

function format(level, event, details = {}) {
  return JSON.stringify({
    ts: now(),
    level,
    event,
    ...sanitize(details)
  });
}

function emit(level, event, details) {
  if (!LEVELS.includes(level)) return;
  const line = format(level, event, details);
  if (level === 'error') {
    console.error(line);
    return;
  }
  console.log(line);
}

module.exports = {
  debug(event, details) { emit('debug', event, details); },
  info(event, details) { emit('info', event, details); },
  warn(event, details) { emit('warn', event, details); },
  error(event, details) { emit('error', event, details); },
  request(req, res, startMs) {
    const status = res && res.statusCode ? res.statusCode : 500;
    emit('info', 'http_request', {
      request_id: req && req.requestId ? req.requestId : null,
      method: req && req.method ? req.method : 'UNKNOWN',
      path: req && req.originalUrl
        ? req.originalUrl.split('?')[0]
        : (req && req.path ? req.path : ''),
      status,
      tenant_id: req && req.tenantId ? req.tenantId : null,
      tenant: req && req.tenant && req.tenant.subdomain ? req.tenant.subdomain : null,
      ip: req && req.ip ? req.ip : null,
      duration_ms: Date.now() - startMs,
      user_agent: req && req.get ? req.get('user-agent') : null
    });
  }
};
