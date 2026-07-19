# Staging Setup — Step-by-Step (first-time operator)

Goal: a live staging environment (web + API + worker + Postgres + Redis) so
Phase 0 discovery can run with real Nuport/Steadfast credentials.
Time: ~45–60 minutes. Cost: ≈ US$5–10/month (Neon & Upstash free tiers +
two small always-on Fly machines).

> **Golden rule:** secrets (API keys, passwords, connection strings) are
> typed ONLY into provider dashboards, `fly secrets set`, or `psql` on your
> own machine. Never into chat, git, or screenshots.

## 0. On your laptop (once)

```bash
# Node 22 + pnpm
corepack enable
# Fly CLI  (macOS: brew install flyctl · Windows: iwr https://fly.io/install.ps1 -useb | iex)
curl -L https://fly.io/install.sh | sh
# Postgres client (psql) — macOS: brew install libpq && brew link --force libpq
git clone https://github.com/mehedihasan8827-dotcom/pure-foodmart-erp && cd pure-foodmart-erp
pnpm install
```

## 1. Neon — managed Postgres (neon.tech)

1. Sign up (GitHub login is easiest) → **New project**:
   name `pfm-staging`, Postgres **16**, region **AWS ap-southeast-1 (Singapore)**.
2. On the project dashboard, copy the **connection string** for the default
   role (this role owns the DB and can run migrations). Keep it as
   `ADMIN_URL` in your head — you'll paste it into commands below, never into git.
3. Apply the schema + platform seed from your laptop:

```bash
DATABASE_URL='<ADMIN_URL>' pnpm db:migrate
DATABASE_URL='<ADMIN_URL>' pnpm db:seed
```

4. Activate the runtime roles (generate two strong passwords with
   `openssl rand -hex 24`):

```bash
psql '<ADMIN_URL>' <<'SQL'
ALTER ROLE pfm_app LOGIN PASSWORD '<APP_PW>';
ALTER ROLE pfm_platform LOGIN PASSWORD '<PLATFORM_PW>';
ALTER ROLE pfm_platform BYPASSRLS;   -- see note below if this errors
GRANT pfm_app TO CURRENT_USER;       -- lets you test as the app role
SQL
```

   **If `BYPASSRLS` is refused** (some managed providers restrict it):
   staging can run with the admin role standing in for `pfm_platform` —
   note it and tell Claude; production gets a provider/plan where it works.

5. Build the **runtime** URL for the app: take `ADMIN_URL` and swap the
   user/password for `pfm_app:<APP_PW>`. That is your `DATABASE_URL` for
   Fly. Sanity-check it:

```bash
psql 'postgres://pfm_app:<APP_PW>@<same-host>/<same-db>?sslmode=require' \
  -c "SELECT count(*) FROM journal_entries;"   # → 0 rows (RLS, no tenant ctx) ✓
```

## 2. Upstash — managed Redis (upstash.com)

1. Sign up → **Create database**: name `pfm-staging`,
   region **ap-southeast-1**, TLS on.
2. Copy the **`rediss://...` connection URL** (the TLS one). That's `REDIS_URL`.

## 3. Fly.io — the three apps (fly.io)

```bash
fly auth signup            # add a payment card when prompted
PREFIX=pfm-<yourname>      # Fly app names are globally unique — pick a prefix

fly apps create $PREFIX-api
fly apps create $PREFIX-worker
fly apps create $PREFIX-web

# Secrets (paste real values here — this goes to Fly, not to git/chat):
fly secrets set -a $PREFIX-api    NODE_ENV=production \
  DATABASE_URL='<runtime pfm_app URL>' REDIS_URL='<rediss URL>' \
  CREDENTIALS_MASTER_KEY=$(openssl rand -hex 32)
fly secrets set -a $PREFIX-worker NODE_ENV=production \
  DATABASE_URL='<runtime pfm_app URL>' REDIS_URL='<rediss URL>' \
  CREDENTIALS_MASTER_KEY='<SAME value as the api — copy it, do not regenerate>'
fly secrets set -a $PREFIX-web    API_UPSTREAM=http://$PREFIX-api.internal:3000

# Edit the three infra/fly.*.toml files: replace CHANGE-ME app names, then:
fly deploy -c infra/fly.api.toml    -a $PREFIX-api
fly deploy -c infra/fly.worker.toml -a $PREFIX-worker
fly deploy -c infra/fly.web.toml    -a $PREFIX-web
```

Verify:

```bash
curl https://$PREFIX-api.fly.dev/api/v1/health     # {"status":"ok",...}
open https://$PREFIX-web.fly.dev                   # login screen + demo mode
fly logs -a $PREFIX-worker | head                  # "booted — ... running"
```

## 4. Bootstrap (once — do these in order)

```bash
B=https://$PREFIX-web.fly.dev/api/v1
# 1. First super admin (endpoint permanently dies after this):
curl -X POST $B/auth/bootstrap -H 'Content-Type: application/json' \
  -d '{"email":"<you>","fullName":"<name>","password":"<strong 10+ chars>"}'
# 2. In the web app: log in → More → (B10 will add the UI; for now)
#    POST /auth/totp/setup → scan the otpauth:// URI with Google
#    Authenticator → POST /auth/totp/enable {secret, code}.
#    DO THIS NOW — period close is impossible without it (§15).
# 3. Provision the merchant + invite yourself as TENANT_ADMIN
#    (runbook §4 steps 3–4).
```

## 5. Phase 0 discovery inputs

1. **Nuport webhook:** issue the token (runbook §4 step 5) and configure
   `https://$PREFIX-web.fly.dev/api/v1/webhooks/nuport/<token>` in Nuport.
   Let a few real order events arrive, then export their shapes:

```bash
psql '<ADMIN_URL>' -c \
 "SELECT jsonb_pretty(payload) FROM nuport_events ORDER BY id DESC LIMIT 3;"
```

   **Redact customer names/phones/addresses**, then share the JSON shapes
   with Claude. That's what locks the field mapping.

2. **Steadfast:** from your laptop, with your real keys (keys stay on your
   machine — share only the *response bodies*, redacted):

```bash
curl -s -H "Api-Key: <KEY>" -H "Secret-Key: <SECRET>" \
  https://portal.packzy.com/api/v1/get_balance
curl -s -H "Api-Key: <KEY>" -H "Secret-Key: <SECRET>" \
  https://portal.packzy.com/api/v1/status_by_cid/<a real consignment id>
```

   Also check the merchant portal for any payout/invoice API or CSV export —
   that decides whether settlement automation runs on API or CSV (§6.3).

## 6. What to report back

- staging URLs (web + api) and that health/login/demo work
- whether `BYPASSRLS` applied cleanly on Neon
- 2–3 redacted Nuport payloads + the two Steadfast response shapes
- whether payout-invoice data is available via API on your Steadfast tier

With those in hand, Claude locks the canonical field mappings (a config
change, not a code change) and B10 proceeds against a live staging.
