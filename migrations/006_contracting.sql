-- ===========================================================================
-- 006_contracting.sql — fluxo de contratação self-service (mensal, PIX manual)
--
-- O cliente cria a conta na landing page (/landing) ANTES de pagar:
--   1. POST /api/public/signup        -> cria loja (trial) + assinatura
--                                        com status awaiting_payment
--   2. O admin envia a chave PIX no WhatsApp
--   3. Cliente paga e informa o pagamento (gera payment_proof pendente)
--   4. Admin aprova no painel -> ativa o plano por 30 dias e gera o
--      código de acesso (access_code)
--
-- "subscriptions" é a tabela de assinatura descrita no contrato; enquanto o
-- pagamento não é confirmado, a assinatura NÃO libera recursos pagos.
-- ===========================================================================

CREATE TABLE IF NOT EXISTS subscriptions (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id      UUID NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
  plan           VARCHAR(50) NOT NULL,
  price_monthly  NUMERIC(10,2) NOT NULL DEFAULT 0,
  billing_cycle  VARCHAR(20) NOT NULL DEFAULT 'monthly',
  status         VARCHAR(20) NOT NULL DEFAULT 'awaiting_payment',
  signup_token   TEXT NOT NULL DEFAULT '',
  access_code    TEXT NOT NULL DEFAULT '',
  contact_name   TEXT NOT NULL DEFAULT '',
  contact_email  TEXT NOT NULL DEFAULT '',
  contact_phone  TEXT NOT NULL DEFAULT '',
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  activated_at   TIMESTAMPTZ,
  renews_at      TIMESTAMPTZ,
  cancelled_at   TIMESTAMPTZ
);

-- token de acompanhamento público (o cliente usa para ver o status)
CREATE UNIQUE INDEX IF NOT EXISTS idx_subs_token
  ON subscriptions (signup_token) WHERE signup_token <> '';
CREATE INDEX IF NOT EXISTS idx_subs_status ON subscriptions (status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_subs_tenant ON subscriptions (tenant_id);

-- Liga o lead da landing page à assinatura e à loja criada
ALTER TABLE saas_leads ADD COLUMN IF NOT EXISTS subscription_id UUID REFERENCES subscriptions (id) ON DELETE SET NULL;
ALTER TABLE saas_leads ADD COLUMN IF NOT EXISTS tenant_id UUID REFERENCES tenants (id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS idx_saas_leads_sub ON saas_leads (subscription_id);