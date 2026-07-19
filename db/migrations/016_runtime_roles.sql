-- 016: Production runtime roles (B13 hardening; promised in 003/013/§15).
--
--   pfm_app       the API/worker runtime role. NOT the table owner, so:
--                 * RLS applies to it everywhere (FORCE was belt-and-braces)
--                 * no DDL, no TRUNCATE (TRUNCATE bypasses row triggers)
--                 * journal tables are INSERT/SELECT only — UPDATE/DELETE
--                   are not even granted, on top of the append-only triggers
--   pfm_platform  super-admin jobs & Super Admin panel backend: BYPASSRLS
--                 for cross-tenant reads (global health, tenant management).
--                 Break-glass usage is expected to be audited (§15).
--
-- Roles are NOLOGIN here; deployment enables login with secrets, and a
-- DB admin attaches BYPASSRLS to pfm_platform (superuser-only attribute):
--   ALTER ROLE pfm_app LOGIN PASSWORD '...';
--   ALTER ROLE pfm_platform LOGIN PASSWORD '...' ;
--   ALTER ROLE pfm_platform BYPASSRLS;              (see docs/runbook.md)
-- The migration runner itself needs CREATEROLE for this file.

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'pfm_app') THEN
    CREATE ROLE pfm_app NOLOGIN;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'pfm_platform') THEN
    CREATE ROLE pfm_platform NOLOGIN;
  END IF;
END $$;

GRANT USAGE ON SCHEMA public TO pfm_app, pfm_platform;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO pfm_app, pfm_platform;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA public TO pfm_app, pfm_platform;

-- Baseline: full DML for the app role...
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public
  TO pfm_app, pfm_platform;

-- ...then tighten the ledger: append-only at the GRANT layer too.
REVOKE UPDATE, DELETE ON journal_entries, journal_lines FROM pfm_app, pfm_platform;
-- (ledger_sequence keeps UPDATE — it is the posting serialization point)

-- Nobody but the owner touches migration bookkeeping.
REVOKE ALL ON schema_migrations FROM pfm_app, pfm_platform;

-- Future objects created by the owner inherit the same defaults.
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO pfm_app, pfm_platform;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT USAGE, SELECT ON SEQUENCES TO pfm_app, pfm_platform;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT EXECUTE ON FUNCTIONS TO pfm_app, pfm_platform;
