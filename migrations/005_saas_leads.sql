-- ---------------------------------------------------------------------------
-- 005_saas_leads.sql
-- - saas_leads: intenções de contratação do SaaS registradas na landing page
--   (/landing) quando o visitante clica em "Assinar" / "Falar no WhatsApp".
--   Serve para notificar o Super Admin em tempo real (polling /stats).
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS saas_leads (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  plan       VARCHAR(50) NOT NULL DEFAULT '',
  name       TEXT NOT NULL DEFAULT '',
  whatsapp   TEXT NOT NULL DEFAULT '',
  message    TEXT NOT NULL DEFAULT '',
  source     VARCHAR(30) NOT NULL DEFAULT 'landing',
  status     VARCHAR(20) NOT NULL DEFAULT 'new',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_saas_leads_status ON saas_leads (status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_saas_leads_created ON saas_leads (created_at DESC);
