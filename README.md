# Pure Foodmart ERP

**Multi-tenant SaaS** financial ERP & cash-flow platform for e-commerce
merchants. Each merchant (tenant) connects their own **Nuport** (OMS) and
**Steadfast** (courier) API credentials and gets an airtight, fully
isolated double-entry ledger: automated revenue + BOM-driven COGS posting,
three-stage courier fund tracking, partner equity, fixed assets, and
real-time dashboards. Desktop web (PWA) + Android (Capacitor) from one
codebase.

**Tenancy model:** single Postgres, shared schema, `tenant_id` everywhere,
enforced by **Row-Level Security** (FORCEd — even the table owner is
subject to it). Every transaction sets `app.tenant_id`; per-tenant gapless
ledger sequences, hash chains, chart of accounts, and fiscal periods are
created atomically by `provision_tenant()`.
**Roles:** platform **Super Admin** (`users.is_super_admin`, BYPASSRLS ops
role in production) and per-merchant memberships in `tenant_users`:
`TENANT_ADMIN` / `ACCOUNTANT` / `STAFF` / `VIEWER`.

**Architecture contract:** [`docs/pure-foodmart-erp-blueprint.md` in the zikr-light repo](https://github.com/mehedihasan8827-dotcom/zikr-light/blob/main/docs/pure-foodmart-erp-blueprint.md) — every design decision lives there; this repo implements it batch by batch (blueprint §18.3).

## Layout

```
apps/
  api/      NestJS HTTP API (webhooks, portals, reporting)
  worker/   Queue consumers & schedulers (pipelines, depreciation, verifiers)
  web/      React + Vite + Tailwind (responsive web / PWA / Capacitor Android)
packages/
  domain/            Shared types + exact Money (integer-poisha) arithmetic
  ledger/            Double-entry journal engine (sole journal writer)
  inventory/         BOM explosion + moving weighted-average costing
  nuport-client/     Typed Nuport API client
  steadfast-client/  Typed Steadfast API client
db/migrations/       Forward-only SQL migrations (B1)
```

Orchestration is plain `pnpm -r` (no turbo — one less moving part at this size).

## Quickstart (local)

```bash
corepack enable                 # provides pnpm
pnpm install
docker compose up -d            # Postgres 16 + Redis (local only)
cp .env.example .env            # fill local values; real secrets stay in the host's secret manager
pnpm db:migrate && pnpm db:seed # apply schema + chart of accounts
pnpm build && pnpm test
pnpm dev:api                    # http://localhost:3000/api/v1/health
pnpm dev:web                    # http://localhost:5173
```

## Batch status

| Batch | Scope | Status |
|-------|-------|--------|
| B0 | Monorepo scaffold, docker-compose, CI, app skeletons | ✅ done |
| B1 | Database migrations + seed (blueprint §9, §3) | ✅ done |
| B2 | Ledger core (posting engine, hash chain, DB-enforced invariants) | ✅ done |
| B2.5 | Multi-tenant SaaS refactor: RLS isolation, tenant provisioning, RBAC model | ✅ done |
| B3 | Inventory/BOM engine (MWA costing, merge-explosion, COGS auto-deduction) | ✅ done |
| B4 | Nuport pipeline (client, webhook receiver, state machine, cron loop) | ✅ done |
| B5 | Steadfast pipeline (client, status poller, 3-stage fund settlement, CSV fallback, drift checks) | ✅ done |
| B6 | Portals API (expenses, purchases, equity, assets + depreciation, stock counts, period close) | ✅ done |
| B7 | Auth & RBAC: Argon2id, TOTP 2FA, hashed sessions, role matrix, Super Admin panel | ✅ done |
| B8 | Frontend foundation: Pure Ledger design system, responsive shell, auth screens, i18n (en/bn), demo mode | ✅ done |
| B9 | Reporting API, SSE live refresh, validated charts, poisha-exact dashboards | ✅ done |
| B10–B13 | Portals UI, reports, Android, deployment | ⏳ next |
