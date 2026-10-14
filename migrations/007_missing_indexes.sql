-- ===========================================================================
-- 007_missing_indexes.sql — Índices para performance e segurança
-- ===========================================================================

-- Refresh tokens cleanup (tenant_id + revoked_at + expires_at)
CREATE INDEX IF NOT EXISTS idx_refresh_tokens_cleanup
  ON refresh_tokens (tenant_id, revoked_at, expires_at);

-- Payment proofs por tenant+status
CREATE INDEX IF NOT EXISTS idx_payment_proofs_tenant_status
  ON payment_proofs (tenant_id, status);

-- Tenants para billing (status + plan)
CREATE INDEX IF NOT EXISTS idx_tenants_billing
  ON tenants (status, plan) WHERE deleted_at IS NULL;

-- Super admin audit por actor
CREATE INDEX IF NOT EXISTS idx_super_audit_actor
  ON super_admin_audit (actor_id, created_at DESC);

-- Subscriptions por tenant+status
CREATE INDEX IF NOT EXISTS idx_subscriptions_tenant_status
  ON subscriptions (tenant_id, status);

-- SaaS leads por status+created_at (já existe idx_saas_leads_status, mas composto ajuda)
CREATE INDEX IF NOT EXISTS idx_saas_leads_status_created
  ON saas_leads (status, created_at DESC);

-- Orders por tenant+created_at para revenue queries
CREATE INDEX IF NOT EXISTS idx_orders_tenant_created_revenue
  ON orders (tenant_id, created_at DESC);

-- Users por tenant+active para contagens de quota
CREATE INDEX IF NOT EXISTS idx_users_tenant_active_count
  ON users (tenant_id, active) WHERE active;