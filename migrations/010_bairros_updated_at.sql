-- ===========================================================================
-- 010_bairros_updated_at.sql — Adiciona updated_at na tabela bairros
-- ===========================================================================

ALTER TABLE bairros ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW();

DROP TRIGGER IF EXISTS update_bairros_updated_at ON bairros;
CREATE TRIGGER update_bairros_updated_at BEFORE UPDATE ON bairros
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();