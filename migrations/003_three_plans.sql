-- ===========================================================================
-- 003_three_plans.sql — a plataforma trabalha com 3 planos:
-- free (Grátis), starter (Start), pro (Pro)
-- Tenants que estavam em business/enterprise migram para pro;
-- os planos removidos saem da tabela.
-- ===========================================================================

UPDATE tenants SET plan = 'pro', updated_at = NOW()
WHERE plan IN ('business', 'enterprise');

DELETE FROM plans WHERE id IN ('business', 'enterprise');

-- nomes comerciais dos 3 planos
UPDATE plans SET name = 'Grátis' WHERE id = 'free';
UPDATE plans SET name = 'Start' WHERE id = 'starter';
UPDATE plans SET name = 'Pro' WHERE id = 'pro';
