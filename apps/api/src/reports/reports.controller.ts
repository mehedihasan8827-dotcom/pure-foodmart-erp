import {
  Controller,
  Get,
  Inject,
  Query,
  UseFilters,
  UseGuards,
} from "@nestjs/common";
import { withTransaction } from "@pfm/ledger";
import {
  getDailySeries,
  getDashboard,
  getFundsBoard,
  getTrialBalanceReport,
} from "@pfm/reports";
import type { Pool } from "pg";
import { AuthErrorFilter } from "../auth/auth-error.filter";
import { AuthGuard } from "../auth/auth.guard";
import { Roles, TenantRoleGuard } from "../auth/roles.guard";
import { PG_POOL } from "../db/database.module";
import { PortalErrorFilter } from "../portal/portal-error.filter";
import { TenantId } from "../portal/tenant.guard";

/** Read-only reporting — every tenant role including VIEWER (§19.2). */
@Controller("portal/reports")
@UseGuards(AuthGuard, TenantRoleGuard)
@UseFilters(PortalErrorFilter, AuthErrorFilter)
@Roles("TENANT_ADMIN", "ACCOUNTANT", "STAFF", "VIEWER")
export class ReportsController {
  constructor(@Inject(PG_POOL) private readonly pool: Pool) {}

  @Get("dashboard")
  dashboard(@TenantId() tenantId: number) {
    return withTransaction(this.pool, tenantId, (c) => getDashboard(c));
  }

  @Get("daily")
  daily(@TenantId() tenantId: number, @Query("days") days?: string) {
    const n = Number(days ?? 14);
    return withTransaction(this.pool, tenantId, (c) =>
      getDailySeries(c, Number.isFinite(n) ? n : 14),
    );
  }

  @Get("funds")
  funds(@TenantId() tenantId: number) {
    return withTransaction(this.pool, tenantId, (c) => getFundsBoard(c));
  }

  @Get("trial-balance")
  trialBalance(@TenantId() tenantId: number) {
    return withTransaction(this.pool, tenantId, (c) => getTrialBalanceReport(c));
  }
}
