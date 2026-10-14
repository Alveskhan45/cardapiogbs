-- ===========================================================================
-- 008_account_lockout.sql — Lockout de conta após tentativas falhadas
-- ===========================================================================

-- Adiciona colunas para controle de lockout na tabela users
ALTER TABLE users
  ADD COLUMN IF NOT EXISTS failed_login_attempts INT NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS locked_until TIMESTAMPTZ;

-- Índice para consultas de lockout
CREATE INDEX IF NOT EXISTS idx_users_locked_until ON users (locked_until) WHERE locked_until IS NOT NULL;

-- Adiciona colunas para controle de lockout na tabela super_admins
ALTER TABLE super_admins
  ADD COLUMN IF NOT EXISTS failed_login_attempts INT NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS locked_until TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_super_admins_locked_until ON super_admins (locked_until) WHERE locked_until IS NOT NULL;