-- ---------------------------------------------------------------------------
-- 004_platform_settings.sql
-- - saas_templates.support_whatsapp: número de WhatsApp de contato/divulgação
--   da plataforma, usado nos botões da landing page (/landing).
-- ---------------------------------------------------------------------------
ALTER TABLE saas_templates
  ADD COLUMN IF NOT EXISTS support_whatsapp TEXT NOT NULL DEFAULT '';
