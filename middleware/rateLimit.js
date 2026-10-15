'use strict';

const rateLimit = require('express-rate-limit');
const { ipKeyGenerator } = rateLimit;
const Redis = require('ioredis');

let redisClient = null;
function getRedisClient() {
  if (redisClient) return redisClient;
  const url = process.env.REDIS_URL;
  if (!url) return null;
  try {
    redisClient = new Redis(url, {
      maxRetriesPerRequest: 3,
      retryStrategy: (times) => Math.min(times * 100, 3000),
      lazyConnect: true
    });
    redisClient.on('error', (e) => {
      console.warn('[rateLimit] Redis error:', e.message);
    });
    redisClient.connect().catch(() => {});
    return redisClient;
  } catch (e) {
    console.warn('[rateLimit] Failed to init Redis:', e.message);
    return null;
  }
}

function createStore() {
  const redis = getRedisClient();
  if (!redis) return undefined; // fallback to memory store
  
  return {
    async increment(key, windowMs) {
      const now = Date.now();
      const pipeline = redis.pipeline();
      pipeline.incr(key);
      pipeline.pexpire(key, windowMs);
      pipeline.pttl(key);
      const results = await pipeline.exec();
      const totalHits = results[0][1];
      const ttl = results[2][1];
      return {
        totalHits,
        resetTime: new Date(now + ttl),
        isFirstInWindow: totalHits === 1
      };
    },
    async decrement(key) {
      await redis.decr(key);
    },
    async resetKey(key) {
      await redis.del(key);
    }
  };
}

function createRateLimiter(options = {}) {
  const {
    windowMs = 15 * 60 * 1000,
    max = 100,
    message = { ok: false, error: 'Muitas requisições. Tente novamente mais tarde.' },
    standardHeaders = true,
    legacyHeaders = false,
    keyGenerator = (req) => ipKeyGenerator(req.ip),
    skip = () => false,
    ...rest
  } = options;

  const store = createStore();
  
  return rateLimit({
    windowMs,
    max,
    message,
    standardHeaders,
    legacyHeaders,
    keyGenerator,
    skip,
    store,
    ...rest
  });
}

/* O express-rate-limit exige ipKeyGenerator(req.ip) em keyGenerator
   próprio: usado direto, req.ip casaria por /64 em IPv6 — o atacante
   troca de endereço dentro da mesma subrede e zera o contador. */
const loginKey = (req) => `login:${req.tenantId || 'global'}:${ipKeyGenerator(req.ip)}`;
const superLoginKey = (req) => `superlogin:${ipKeyGenerator(req.ip)}`;
const tenantCreateKey = (req) => `tenant-create:${req.user?.sub || ipKeyGenerator(req.ip)}`;
const apiKey = (req) => `api:${req.tenantId || 'global'}:${ipKeyGenerator(req.ip)}`;
const paymentProofKey = (req) => `payment-proof:${req.tenantId}:${ipKeyGenerator(req.ip)}`;

const loginLimiter = createRateLimiter({
  windowMs: 15 * 60 * 1000,
  max: 10,
  keyGenerator: loginKey,
  message: { ok: false, error: 'Muitas tentativas de login. Aguarde 15 minutos.' }
});

const superLoginLimiter = createRateLimiter({
  windowMs: 15 * 60 * 1000,
  max: 10,
  keyGenerator: superLoginKey,
  message: { ok: false, error: 'Muitas tentativas. Aguarde alguns minutos.' }
});

const tenantCreateLimiter = createRateLimiter({
  windowMs: 60 * 60 * 1000,
  max: 10,
  keyGenerator: tenantCreateKey,
  message: { ok: false, error: 'Muitas lojas criadas em pouco tempo. Tente novamente mais tarde.' }
});

const apiLimiter = createRateLimiter({
  windowMs: 60 * 1000,
  max: 60,
  keyGenerator: apiKey,
  message: { ok: false, error: 'Limite de requisições excedido. Aguarde um momento.' }
});

const paymentProofLimiter = createRateLimiter({
  windowMs: 60 * 60 * 1000,
  max: 5,
  keyGenerator: paymentProofKey,
  message: { ok: false, error: 'Muitos comprovantes enviados. Aguarde uma hora.' }
});

module.exports = {
  createRateLimiter,
  loginLimiter,
  superLoginLimiter,
  tenantCreateLimiter,
  apiLimiter,
  paymentProofLimiter
};