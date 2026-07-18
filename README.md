# Pure Foodmart ERP

Cloud Financial ERP & cash-flow management system for the Pure Foodmart
e-commerce brand. Ingests sales from **Nuport** (OMS) and courier fund /
payout data from **Steadfast**, and turns them into an airtight
double-entry ledger: automated revenue + BOM-driven COGS posting,
three-stage courier fund tracking, partner equity, fixed assets, and
real-time dashboards. Desktop web (PWA) + Android (Capacitor) from one
codebase.

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
pnpm build && pnpm test
pnpm dev:api                    # http://localhost:3000/api/v1/health
pnpm dev:web                    # http://localhost:5173
```

## Batch status

| Batch | Scope | Status |
|-------|-------|--------|
| B0 | Monorepo scaffold, docker-compose, CI, app skeletons | ✅ done |
| B1 | Database migrations + seed (blueprint §9, §3) | ⏳ next |
| B2 | Ledger core (posting engine, hash chain) | — |
| B3 | Inventory/BOM engine | — |
| B4 | Nuport pipeline | — |
| B5 | Steadfast pipeline | — |
| B6–B13 | Portals, auth, frontend, Android, deployment | — |
