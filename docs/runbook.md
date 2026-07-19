# Pure Foodmart ERP — Production Runbook (B13)

The operational contract for staging and production. Blueprint references:
§11 (architecture), §15 (security), §16 (go-live), §19 (SaaS).

## 1. Topology

```
[users] ── https ──▶ web (nginx, static SPA, /api proxied)
                        │
                        ▼
                     api (NestJS)  ◀── Nuport webhooks (/api/v1/webhooks/nuport/<token>)
                        │   ▲ SSE (/api/v1/portal/live)
                        ▼   │
        Postgres 16 (managed, PITR)   Redis (managed)
                        ▲   ▲
                        │   │ BullMQ
                     worker (queues, Steadfast pollers, depreciation cron)
```

Recommended managed services (§11.1): **Fly.io** (api/worker/web, Singapore
region `sin`) + **Neon** Postgres + **Upstash** Redis. Any equivalents work —
the images in `infra/` are plain Docker.

## 2. Secrets (per environment — set in the host's secret manager, never in git)

| Secret | Used by | Notes |
|---|---|---|
| `DATABASE_URL` | api, worker, migrations | Use the **pfm_app** role's credentials at runtime (see §4) |
| `REDIS_URL` | api, worker | Enables queue dispatch + consumers |
| `CREDENTIALS_MASTER_KEY` | api, worker | 64 hex chars: `openssl rand -hex 32`. Seals merchant API keys (§19.3). Rotating requires re-sealing `tenant_integrations`. |
| `NODE_ENV=production` | all | Enables Secure cookies |

Per-merchant Nuport/Steadfast keys are **not** platform secrets — they live
AES-256-GCM-sealed in `tenant_integrations`, entered by each merchant.

## 3. First deploy

```bash
# 1. Postgres: create the database and an ADMIN user for migrations
#    (the migration runner needs CREATEROLE for 016_runtime_roles.sql).

# 2. Apply schema + platform seed (as the admin user):
DATABASE_URL=postgres://ADMIN@.../pure_foodmart_erp pnpm db:migrate
DATABASE_URL=postgres://ADMIN@.../pure_foodmart_erp pnpm db:seed

# 3. Activate runtime roles (one-time, as the provider's superuser/admin):
#    ALTER ROLE pfm_app LOGIN PASSWORD '<generated>';
#    ALTER ROLE pfm_platform LOGIN PASSWORD '<generated>';
#    ALTER ROLE pfm_platform BYPASSRLS;   -- superuser-only attribute
#    Runtime DATABASE_URL for api/worker uses pfm_app.
#    (pfm_app is NOT the table owner: RLS applies, no DDL, no TRUNCATE,
#     and journal tables are INSERT/SELECT only at the GRANT layer.)

# 4. Deploy images (Fly example; region sin):
fly launch --no-deploy --name pfm-api    --dockerfile infra/api.Dockerfile
fly launch --no-deploy --name pfm-worker --dockerfile infra/worker.Dockerfile
fly launch --no-deploy --name pfm-web    --dockerfile infra/web.Dockerfile
fly secrets set -a pfm-api    DATABASE_URL=... REDIS_URL=... CREDENTIALS_MASTER_KEY=... NODE_ENV=production
fly secrets set -a pfm-worker DATABASE_URL=... REDIS_URL=... CREDENTIALS_MASTER_KEY=... NODE_ENV=production
fly secrets set -a pfm-web    API_UPSTREAM=http://pfm-api.internal:3000
fly deploy -a pfm-api && fly deploy -a pfm-worker && fly deploy -a pfm-web
```

## 4. Bootstrap sequence (once, immediately after first deploy)

```bash
B=https://erp.example.com/api/v1
# 1. First (and only bootstrappable) super admin — endpoint dies afterwards:
curl -X POST $B/auth/bootstrap -H 'Content-Type: application/json' \
  -d '{"email":"you@company.com","fullName":"Platform Owner","password":"<strong>"}'
# 2. Log in, ENABLE TOTP IMMEDIATELY (period close requires it, §15):
#    POST /auth/login → POST /auth/totp/setup → scan → POST /auth/totp/enable
# 3. Provision the first merchant:      POST /admin/tenants {name, slug}
# 4. Invite the merchant's TENANT_ADMIN: POST /portal/users (X-Tenant-Id: <id>)
# 5. Issue the Nuport webhook token (psql, as pfm_platform):
#    INSERT INTO webhook_tokens (token, tenant_id, provider)
#    VALUES (encode(gen_random_bytes(24),'hex'), <tenantId>, 'NUPORT')
#    RETURNING token;
#    → configure https://erp.example.com/api/v1/webhooks/nuport/<token> in Nuport
# 6. Store merchant API credentials sealed (until the B10 settings UI):
#    node -e "const{sealCredentials}=require('@pfm/pipeline');
#             console.log(sealCredentials(process.env.CREDENTIALS_MASTER_KEY,
#               {companyId:'...',apiKey:'...'}))"
#    INSERT INTO tenant_integrations (tenant_id, provider, credentials_ciphertext)
#    VALUES (<tenantId>, 'NUPORT', '<sealed>');  -- same for STEADFAST
# 7. Opening balances (§16): count cash/bank/bKash/courier dues/stock, then
#    call postOpeningBalances (B11 exposes the wizard UI; until then a
#    one-off script using @pfm/portals).
```

## 5. Phase 0 — live API discovery (blueprint §18.5, do this on STAGING first)

1. Point Nuport's webhook at staging; capture 2–3 real payloads from
   `nuport_events.payload`.
2. If real field names differ from the canonical schema, set the mapping in
   the Nuport client config (`mapOrder`) — downstream code needs no changes.
3. Steadfast: verify status + balance endpoints with the merchant's keys;
   determine whether payout-invoice detail is exposed on the account tier.
   If not → the CSV fallback carries settlement (§6.3), as designed.

## 6. Routine operations

| Cadence | Task |
|---|---|
| Continuous | Webhooks + queue processing; SSE dashboards |
| Hourly | Steadfast poll (status/invoices/balance drift) — worker |
| Nightly | Nuport completeness pull; integrity invariants I1–I5 |
| Monthly (1st, 03:00 Dhaka) | Depreciation run (worker, idempotent) |
| Monthly (owner) | Stock count → close checklist → period lock (TOTP) |
| Weekly | Restore drill: restore latest backup to a scratch DB, run `pnpm db:status` + a trial-balance query; alert on mismatch |

## 7. Backups & recovery

- Managed Postgres with PITR (Neon: branch-based restore; RDS: WAL). RPO ≤ 5 min.
- After any restore: rewind the Nuport sync cursor 7 days
  (`UPDATE sync_runs SET cursor_after = now() - interval '7 days' WHERE id = (SELECT max(id) ...)`)
  — the completeness loop re-converges; idempotency gates make replays safe (§14.10).
- Hash-chain verification after restore: `verifyHashChain` per tenant (close
  checklist runs it too).

## 8. Incident notes

- **Webhook endpoint down**: no data loss — the nightly pull re-covers
  everything; alert if no events during business hours (§14.6).
- **Queue backlog**: safe to scale worker instances; per-event processing is
  idempotent. Do NOT raise nuport consumer concurrency above 1 without
  per-order grouping.
- **"Period is locked" errors**: intended (§10.4). Owner unlock with reason,
  fix, re-close.
- **RLS returns zero rows in a job**: the transaction forgot
  `set_config('app.tenant_id', …)` — always go through `withTransaction`.
