import { Global, Module } from "@nestjs/common";
import { Pool } from "pg";

export const PG_POOL = "PG_POOL";
export const PG_PLATFORM_POOL = "PG_PLATFORM_POOL";

const LOCAL_FALLBACK = "postgres://erp:erp_local_dev@localhost:5432/pure_foodmart_erp";

/**
 * Two pools for the whole API process:
 *  - PG_POOL: pfm_app (RLS-enforced). Everything tenant-facing. Tenant
 *    context is per-transaction (SET LOCAL app.tenant_id via @pfm/ledger
 *    withTransaction), never per-connection — pooled connections carry no
 *    residual tenant state.
 *  - PG_PLATFORM_POOL: pfm_platform (BYPASSRLS). Super Admin Panel backend
 *    only (AdminController) — per 013_multitenancy_rls.sql/016_runtime_roles.sql's
 *    documented architecture. Tenant provisioning inserts the `tenants` row
 *    itself before any tenant context can exist, which RLS can never
 *    satisfy under pfm_app (id = app_tenant_id() is NULL at insert time).
 *  Local dev has no separate platform role, so PLATFORM_DATABASE_URL falls
 *  back to DATABASE_URL (the docker-compose `erp` owner bypasses RLS anyway).
 */
@Global()
@Module({
  providers: [
    {
      provide: PG_POOL,
      useFactory: () =>
        new Pool({
          connectionString: process.env.DATABASE_URL ?? LOCAL_FALLBACK,
          max: 10,
        }),
    },
    {
      provide: PG_PLATFORM_POOL,
      useFactory: () =>
        new Pool({
          connectionString:
            process.env.PLATFORM_DATABASE_URL ?? process.env.DATABASE_URL ?? LOCAL_FALLBACK,
          max: 5,
        }),
    },
  ],
  exports: [PG_POOL, PG_PLATFORM_POOL],
})
export class DatabaseModule {}
