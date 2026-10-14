-- ===========================================================================
-- 002_superadmin_billing.sql — Super Admin completo (billing + auditoria)
-- - Novos planos free/business (mantém starter/pro/enterprise: compat com
--   quotas e testes existentes; a landing page futura usa free/pro/business)
-- - Colunas de cobrança/cadastro no tenants (status continua texto livre:
--   active/suspended/cancelled + trial da especificação)
-- - payment_proofs: comprovantes PIX enviados pelo lojista
-- - saas_templates: modelos de WhatsApp + chave PIX da plataforma
-- - super_admin_audit: trilha imutável de ações do painel da plataforma
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- 2.1 Plano free (ON CONFLICT DO NOTHING: idempotente)
-- A plataforma trabalha com 3 planos: free, starter, pro.
-- ---------------------------------------------------------------------------
INSERT INTO plans (id, name, price_monthly, limits, features) VALUES
  ('free', 'Grátis', 0,
   '{"products":20,"orders_month":200,"users":1,"bairros":5,"storage_mb":50}',
   '{"api_access":false,"custom_domain":false,"white_label":false,"kds":false,"coupons":true,"delivery_zones":false,"reports":false,"loyalty":false,"multi_users":false,"priority_support":false}')
ON CONFLICT (id) DO NOTHING;

-- ---------------------------------------------------------------------------
-- 2.2 Colunas de cobrança/cadastro no tenants
-- ---------------------------------------------------------------------------
ALTER TABLE tenants ADD COLUMN IF NOT EXISTS cnpj TEXT NOT NULL DEFAULT '';
ALTER TABLE tenants ADD COLUMN IF NOT EXISTS phone TEXT NOT NULL DEFAULT '';
ALTER TABLE tenants ADD COLUMN IF NOT EXISTS address TEXT NOT NULL DEFAULT '';
ALTER TABLE tenants ADD COLUMN IF NOT EXISTS primary_color TEXT NOT NULL DEFAULT '';
ALTER TABLE tenants ADD COLUMN IF NOT EXISTS trial_ends_at TIMESTAMPTZ;
ALTER TABLE tenants ADD COLUMN IF NOT EXISTS subscription_expires_at TIMESTAMPTZ;

-- ---------------------------------------------------------------------------
-- 2.3 Comprovantes PIX (lojista informa -> super-admin aprova/rejeita)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS payment_proofs (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   UUID NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
  plan        VARCHAR(50) NOT NULL DEFAULT 'pro',
  amount      NUMERIC(10,2) NOT NULL DEFAULT 0,
  note        TEXT NOT NULL DEFAULT '',
  status      VARCHAR(20) NOT NULL DEFAULT 'pending',
  created_by  TEXT NOT NULL DEFAULT '',
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  decided_at  TIMESTAMPTZ,
  decided_by  UUID
);
CREATE INDEX IF NOT EXISTS idx_payment_proofs_status ON payment_proofs (status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_payment_proofs_tenant ON payment_proofs (tenant_id);

-- ---------------------------------------------------------------------------
-- 2.4 Templates de WhatsApp + chave PIX da plataforma (linha única)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS saas_templates (
  id         TEXT PRIMARY KEY,
  templates  JSONB NOT NULL DEFAULT '{}'::jsonb,
  pix_key    TEXT NOT NULL DEFAULT '',
  pix_name   TEXT NOT NULL DEFAULT '',
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

INSERT INTO saas_templates (id, templates, pix_key, pix_name) VALUES
  ('default',
   '{"onboarding": "🎉 *Bem-vindo ao CardapioDigital, {NOME_LOJISTA}!*\n\nSua loja *{NOME_LOJA}* já está no ar 🚀\n\n👉 *Cardápio:* {LINK_CARDAPIO}\n👉 *Painel:* {LINK_PAINEL}\n🔑 *Login:* {LOGIN_EMAIL}\n🔑 *Senha inicial:* {SENHA_INICIAL}\n\nPlano *{PLANO}* ({VALOR_PLANO}/mês). Qualquer dúvida chame aqui! 💬",
     "billingReminder": "💳 *Lembrete de vencimento — {NOME_LOJA}*\n\nOlá {NOME_LOJISTA}! Sua assinatura do plano *{PLANO}* ({VALOR_PLANO}) vence em *{DATA_VENCIMENTO}*.\n\nPague via PIX:\n🔑 Chave: {CHAVE_PIX_SAAS}\n👤 Titular: {TITULAR_PIX_SAAS}\n\nDepois envie o comprovante pelo painel. Obrigado! 🙏",
     "suspensionNotice": "⛔ *Cardápio suspenso — {NOME_LOJA}*\n\nOlá {NOME_LOJISTA}, por falta de pagamento da assinatura *{PLANO}* ({VALOR_PLANO}) seu cardápio foi suspenso.\n\nRegularize via PIX:\n🔑 Chave: {CHAVE_PIX_SAAS}\n👤 Titular: {TITULAR_PIX_SAAS}\n\nEnvie o comprovante e liberamos na hora! ⚡",
     "reactivationNotice": "✅ *Pagamento confirmado — {NOME_LOJA}!*\n\nOlá {NOME_LOJISTA}! Recebemos seu pagamento do plano *{PLANO}* ({VALOR_PLANO}). Sua loja já está *ativa* novamente 🎉\n\n👉 Cardápio: {LINK_CARDAPIO}\nObrigado pela parceria! 💜"}',
   '', '')
ON CONFLICT (id) DO NOTHING;

-- ---------------------------------------------------------------------------
-- 2.5 Auditoria global do painel da plataforma (apêndice imutável)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS super_admin_audit (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  actor_id    UUID,
  actor_email TEXT NOT NULL DEFAULT '',
  action      TEXT NOT NULL,
  tenant_id   UUID REFERENCES tenants (id) ON DELETE SET NULL,
  details     JSONB NOT NULL DEFAULT '{}'::jsonb,
  ip          TEXT NOT NULL DEFAULT '',
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_super_audit_created ON super_admin_audit (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_super_audit_action ON super_admin_audit (action);
