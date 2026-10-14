-- ===========================================================================
-- 000_init_roles.sql — papéis (roles) do SaaS
-- Roda em qualquer ambiente: no primeiro init do volume do Postgres
-- (docker-entrypoint-initdb.d) e idempotentemente pelo scripts/migrate.js
-- (papéis só são criados se ainda não existirem).
-- O superusuário postgres existe só para bootstrap; o app nunca roda como ele.
-- ===========================================================================

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'cardapio_app') THEN
    CREATE ROLE cardapio_app LOGIN PASSWORD 'cardapio_app' NOSUPERUSER NOBYPASSRLS;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'cardapio_admin') THEN
    CREATE ROLE cardapio_admin LOGIN PASSWORD 'cardapio_admin' NOSUPERUSER BYPASSRLS CREATEDB;
  END IF;
END
$$;

-- Concede privilégios no banco principal. Em outros bancos (ex.: banco de
-- testes) o criador já tem tudo; os GRANT de tabelas saem do migrate.js.
DO $$
BEGIN
  IF current_database() = 'cardapio_saas' THEN
    GRANT ALL PRIVILEGES ON DATABASE cardapio_saas TO cardapio_app;
    GRANT ALL PRIVILEGES ON DATABASE cardapio_saas TO cardapio_admin;
  END IF;
  GRANT CREATE, USAGE ON SCHEMA public TO cardapio_app;
  GRANT CREATE, USAGE ON SCHEMA public TO cardapio_admin;
END
$$;
