-- ===========================================================================
-- 001_multi_tenant.sql — Modelo de dados multi-tenant (Fase 1 do plano)
-- Shared database + shared schema: tenant_id em todas as tabelas de dados.
-- RLS (Row Level Security) como defesa em profundidade: o papel do app
-- (cardapio_app) NUNCA vê linhas de outro tenant sem a variável de sessão
-- app.current_tenant_id definida em transação (db/index.js → runTenant).
-- ===========================================================================

CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- ---------------------------------------------------------------------------
-- 1.1 Tenants
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS tenants (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name         VARCHAR(200) NOT NULL,
  subdomain    VARCHAR(100) UNIQUE NOT NULL,
  slug         VARCHAR(100) UNIQUE NOT NULL,
  plan         VARCHAR(50) NOT NULL DEFAULT 'starter',
  status       VARCHAR(20) NOT NULL DEFAULT 'active',
  settings     JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  deleted_at   TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_tenants_subdomain ON tenants (subdomain);
CREATE INDEX IF NOT EXISTS idx_tenants_status ON tenants (status);

-- ---------------------------------------------------------------------------
-- 1.2 Users (substitui o admin único por N usuários por tenant)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS users (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     UUID NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
  email         VARCHAR(255) NOT NULL,
  password_hash VARCHAR(255) NOT NULL,
  name          VARCHAR(200),
  role          VARCHAR(50) NOT NULL DEFAULT 'admin',
  permissions   JSONB NOT NULL DEFAULT '{}'::jsonb,
  last_login    TIMESTAMPTZ,
  active        BOOLEAN NOT NULL DEFAULT TRUE,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
-- E-mail único por tenant (entre usuários ativos; inativos podem liberar o e-mail)
CREATE UNIQUE INDEX IF NOT EXISTS idx_users_tenant_email_active
  ON users (tenant_id, lower(email)) WHERE active;
CREATE INDEX IF NOT EXISTS idx_users_tenant ON users (tenant_id);

-- ---------------------------------------------------------------------------
-- 1.3 Super-admins da plataforma
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS super_admins (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email         VARCHAR(255) UNIQUE NOT NULL,
  password_hash VARCHAR(255) NOT NULL,
  name          VARCHAR(200),
  active        BOOLEAN NOT NULL DEFAULT TRUE,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ---------------------------------------------------------------------------
-- Refresh tokens (rotação: um token só pode ser usado uma vez)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS refresh_tokens (
  jti         VARCHAR(64) PRIMARY KEY,
  user_id     UUID NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  tenant_id   UUID NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
  expires_at  TIMESTAMPTZ NOT NULL,
  revoked_at  TIMESTAMPTZ,
  replaced_by VARCHAR(64),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_refresh_tokens_tenant ON refresh_tokens (tenant_id);

-- ---------------------------------------------------------------------------
-- 1.4 Tabelas de dados — tenant_id NOT NULL + CASCADE
-- (o payload JSON do app continua em "data"; os índices de isolamento usam
--  as colunas reais tenant_id/id/created_at)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS products (
  tenant_id  UUID NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
  id         TEXT NOT NULL,
  data       JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (tenant_id, id)
);

CREATE TABLE IF NOT EXISTS orders (
  tenant_id  UUID NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
  id         TEXT NOT NULL,
  data       JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (tenant_id, id)
);
CREATE INDEX IF NOT EXISTS idx_orders_tenant_created ON orders (tenant_id, created_at DESC);

CREATE TABLE IF NOT EXISTS coupons (
  tenant_id UUID NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
  id        TEXT NOT NULL,
  data      JSONB NOT NULL,
  PRIMARY KEY (tenant_id, id)
);

CREATE TABLE IF NOT EXISTS bairros (
  tenant_id UUID NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
  id        TEXT NOT NULL,
  data      JSONB NOT NULL,
  PRIMARY KEY (tenant_id, id)
);

CREATE TABLE IF NOT EXISTS categories (
  tenant_id UUID NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
  name      TEXT NOT NULL,
  PRIMARY KEY (tenant_id, name)
);

-- 7.1 Uma linha por (tenant, key) — a config é 1:1 por tenant
CREATE TABLE IF NOT EXISTS config (
  tenant_id UUID NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
  key       TEXT NOT NULL,
  value     JSONB NOT NULL,
  PRIMARY KEY (tenant_id, key)
);

-- Logs de atividade/estoque: 1 linha JSONB por tenant (limite 100/200 entradas
-- no app, então uma linha única é suficiente e muito mais simples)
CREATE TABLE IF NOT EXISTS admin_log (
  tenant_id  UUID PRIMARY KEY REFERENCES tenants (id) ON DELETE CASCADE,
  data       JSONB NOT NULL DEFAULT '[]'::jsonb,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS stock_log (
  tenant_id  UUID PRIMARY KEY REFERENCES tenants (id) ON DELETE CASCADE,
  data       JSONB NOT NULL DEFAULT '[]'::jsonb,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ---------------------------------------------------------------------------
-- 9.1 Planos e limites (quotas)
-- limit = -1 significa ilimitado
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS plans (
  id            VARCHAR(50) PRIMARY KEY,
  name          VARCHAR(100) NOT NULL,
  price_monthly NUMERIC(10,2) NOT NULL DEFAULT 0,
  limits        JSONB NOT NULL,
  features      JSONB NOT NULL DEFAULT '{}'::jsonb
);

INSERT INTO plans (id, name, price_monthly, limits, features) VALUES
  ('starter', 'Starter', 99.90,
   '{"products":100,"orders_month":1000,"users":2,"bairros":10,"storage_mb":100}',
   '{"api_access":false,"custom_domain":false,"white_label":false}'),
  ('pro', 'Pro', 299.90,
   '{"products":500,"orders_month":10000,"users":10,"bairros":50,"storage_mb":1000}',
   '{"api_access":true,"custom_domain":false,"white_label":false}'),
  ('enterprise', 'Enterprise', 999.90,
   '{"products":-1,"orders_month":-1,"users":-1,"bairros":-1,"storage_mb":-1}',
   '{"api_access":true,"custom_domain":true,"white_label":true}')
ON CONFLICT (id) DO NOTHING;

-- ---------------------------------------------------------------------------
-- 1.6 Row Level Security — todas as tabelas multi-tenant
-- FORCE: vale até para o owner da tabela. O papel super-admin (BYPASSRLS)
-- fica isento de propósito (painel da plataforma).
-- NULLIF(current_setting(..., true), '')::uuid: se a variável de sessão não
-- existir (ou vier vazia de uma conexão reutilizada), o resultado é NULL e a
-- policy simplemente não casa — a query devolve vazio em vez de estourar erro.
-- Obs.: a tabela tenants NÃO tem RLS — o lookup de subdomínio precisa
-- acontecer antes de existir variável de sessão (é o "escritório" do SaaS).
-- ---------------------------------------------------------------------------
ALTER TABLE products ENABLE ROW LEVEL SECURITY;
ALTER TABLE products FORCE ROW LEVEL SECURITY;
ALTER TABLE orders ENABLE ROW LEVEL SECURITY;
ALTER TABLE orders FORCE ROW LEVEL SECURITY;
ALTER TABLE coupons ENABLE ROW LEVEL SECURITY;
ALTER TABLE coupons FORCE ROW LEVEL SECURITY;
ALTER TABLE bairros ENABLE ROW LEVEL SECURITY;
ALTER TABLE bairros FORCE ROW LEVEL SECURITY;
ALTER TABLE categories ENABLE ROW LEVEL SECURITY;
ALTER TABLE categories FORCE ROW LEVEL SECURITY;
ALTER TABLE config ENABLE ROW LEVEL SECURITY;
ALTER TABLE config FORCE ROW LEVEL SECURITY;
ALTER TABLE admin_log ENABLE ROW LEVEL SECURITY;
ALTER TABLE admin_log FORCE ROW LEVEL SECURITY;
ALTER TABLE stock_log ENABLE ROW LEVEL SECURITY;
ALTER TABLE stock_log FORCE ROW LEVEL SECURITY;
ALTER TABLE users ENABLE ROW LEVEL SECURITY;
ALTER TABLE users FORCE ROW LEVEL SECURITY;
ALTER TABLE refresh_tokens ENABLE ROW LEVEL SECURITY;
ALTER TABLE refresh_tokens FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenant_isolation ON products;
CREATE POLICY tenant_isolation ON products
  USING (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid);

DROP POLICY IF EXISTS tenant_isolation ON orders;
CREATE POLICY tenant_isolation ON orders
  USING (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid);

DROP POLICY IF EXISTS tenant_isolation ON coupons;
CREATE POLICY tenant_isolation ON coupons
  USING (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid);

DROP POLICY IF EXISTS tenant_isolation ON bairros;
CREATE POLICY tenant_isolation ON bairros
  USING (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid);

DROP POLICY IF EXISTS tenant_isolation ON categories;
CREATE POLICY tenant_isolation ON categories
  USING (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid);

DROP POLICY IF EXISTS tenant_isolation ON config;
CREATE POLICY tenant_isolation ON config
  USING (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid);

DROP POLICY IF EXISTS tenant_isolation ON admin_log;
CREATE POLICY tenant_isolation ON admin_log
  USING (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid);

DROP POLICY IF EXISTS tenant_isolation ON stock_log;
CREATE POLICY tenant_isolation ON stock_log
  USING (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid);

DROP POLICY IF EXISTS tenant_isolation ON users;
CREATE POLICY tenant_isolation ON users
  USING (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid);

DROP POLICY IF EXISTS tenant_isolation ON refresh_tokens;
CREATE POLICY tenant_isolation ON refresh_tokens
  USING (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid);
