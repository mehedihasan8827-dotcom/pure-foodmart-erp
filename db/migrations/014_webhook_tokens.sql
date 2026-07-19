-- 014: Webhook token → tenant resolver.
--
-- Inbound webhooks arrive BEFORE any tenant context exists, so this is an
-- auth-layer table like users/tenant_users: no RLS. The runtime role gets
-- SELECT only (B13 hardening). Tokens are long random hex generated when a
-- merchant configures an integration; the webhook URL is
--   POST /api/v1/webhooks/nuport/<token>
-- Rotating the token = revoking the URL.

CREATE TABLE webhook_tokens (
  token      VARCHAR(64) PRIMARY KEY,
  tenant_id  INT NOT NULL REFERENCES tenants(id),
  provider   integration_provider NOT NULL,
  is_active  BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, provider)
);
