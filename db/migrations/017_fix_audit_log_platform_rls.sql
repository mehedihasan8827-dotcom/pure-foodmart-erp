-- 017: Fix audit_log RLS policy to allow platform-level rows.
--
-- 011_users_audit.sql documents "tenant_id NULL = platform-level action
-- (super admin / system)", but the policy from 013_multitenancy_rls.sql was
-- `tenant_id = app_tenant_id()`, and NULL = NULL is never TRUE in SQL — so
-- every platform-level audit row (e.g. first-run bootstrap) was silently
-- rejected by RLS. IS NOT DISTINCT FROM treats NULL = NULL as true while
-- keeping tenant-scoped rows exactly as isolated as before.

DROP POLICY tenant_audit ON audit_log;
CREATE POLICY tenant_audit ON audit_log
  USING (tenant_id IS NOT DISTINCT FROM app_tenant_id())
  WITH CHECK (tenant_id IS NOT DISTINCT FROM app_tenant_id());
