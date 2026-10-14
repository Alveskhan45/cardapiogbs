const REQUIRED_PROD = {
  NODE_ENV: 'production',
  DATABASE_URL: 'postgres://user:password@host:5432/cardapio',
  SUPER_ADMIN_DATABASE_URL: 'postgres://user:password@host:5432/cardapio',
  JWT_SECRET: '32+ random characters',
  WILDCARD_DOMAIN: 'seusaas.com',
  ALLOWED_ORIGINS: 'https://seusaas.com,https://app.seusaas.com',
  SUPER_ADMIN_PASS: 'strong password',
  PORT: '3001'
};

const PLACEHOLDER_VALUES = [
  'troque-por-um-secreto-longo-aleatorio',
  'troque-por-senha-forte',
  'change-me',
  'changeme',
  'secret',
  'example-password',
  'your-jwt-secret',
  'replace-me',
  'localhost',
  '127.0.0.1'
];

function isPlaceholder(value) {
  if (!value) return true;
  const normalized = String(value).trim().toLowerCase();
  return PLACEHOLDER_VALUES.some(item => normalized.includes(item) || item.includes(normalized));
}

function check() {
  const env = process.env;
  const results = [];
  const producerMode = process.argv.includes('--prod') || process.argv.includes('--production');
  const isProd = producerMode || String(env.NODE_ENV || '').toLowerCase() === 'production';

  for (const [key, example] of Object.entries(REQUIRED_PROD)) {
    const value = String(env[key] || '').trim();
    const valid = Boolean(value) && !isPlaceholder(value);

    if (isProd) {
      if (!valid) {
        results.push({ key, ok: false, hint: `Defina ${key} com um valor real; exemplo: ${example}` });
      } else {
        results.push({ key, ok: true });
      }
    } else {
      if (key === 'NODE_ENV') {
        results.push({ key, ok: true, note: 'modo local; uso real do valor em produção' });
      } else if (key === 'PORT') {
        results.push({ key, ok: true, note: 'porta local padrão 3001 quando indefinida' });
      } else {
        results.push({ key, ok: true, note: `configure antes do rollout em produção` });
      }
    }
  }

  const wildcard = String(env.WILDCARD_DOMAIN || '').trim().toLowerCase();
  const allowedOrigins = String(env.ALLOWED_ORIGINS || '').trim();
  const jwtSecret = String(env.JWT_SECRET || '').trim();

  if (isProd) {
    if (!wildcard || /localhost|127\.0\.0\.1/.test(wildcard)) {
      results.push({ key: 'WILDCARD_DOMAIN', ok: false, hint: 'Use o domínio raiz do SaaS, sem localhost (ex.: seusaas.com)' });
    }
    if (!allowedOrigins || !allowedOrigins.includes('https://')) {
      results.push({ key: 'ALLOWED_ORIGINS', ok: false, hint: 'Inclua HTTPS dos domínios públicos e subdomínios permitidos' });
    }
    if (!jwtSecret || jwtSecret.length < 32) {
      results.push({ key: 'JWT_SECRET', ok: false, hint: 'JWT_SECRET deve ter pelo menos 32 caracteres e ser exclusivo para produção' });
    }
  } else {
    results.push({
      key: 'PRODUCTION_CHECK',
      ok: true,
      note: 'modo local; use NODE_ENV=production ou --prod para aplicar a validação estrita de rollout'
    });
  }

  const failed = isProd ? results.filter(item => item.ok === false) : [];
  const summary = {
    environment: env.NODE_ENV || 'development',
    checks: results.map(item => ({ key: item.key, ok: item.ok, ...(item.note ? { note: item.note } : {}), ...(item.hint ? { hint: item.hint } : {}) })),
    status: failed.length ? 'FAIL' : 'PASS'
  };

  console.log(JSON.stringify(summary, null, 2));

  if (failed.length) {
    process.exit(1);
  }
}

check();
