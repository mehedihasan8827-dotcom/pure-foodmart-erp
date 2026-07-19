import { Global, Module } from "@nestjs/common";
import { Pool } from "pg";

export const PG_POOL = "PG_POOL";

/**
 * One pool for the whole API process. Tenant context is per-transaction
 * (SET LOCAL app.tenant_id via @pfm/ledger withTransaction), never
 * per-connection — pooled connections carry no residual tenant state.
 */
@Global()
@Module({
  providers: [
    {
      provide: PG_POOL,
      useFactory: () =>
        new Pool({
          connectionString:
            process.env.DATABASE_URL ??
            "postgres://erp:erp_local_dev@localhost:5432/pure_foodmart_erp",
          max: 10,
        }),
    },
  ],
  exports: [PG_POOL],
})
export class DatabaseModule {}
