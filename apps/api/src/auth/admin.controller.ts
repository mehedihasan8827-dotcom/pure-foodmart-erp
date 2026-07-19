import {
  Body,
  Controller,
  Get,
  Inject,
  Param,
  Post,
  UseFilters,
  UseGuards,
} from "@nestjs/common";
import type { SessionPrincipal } from "@pfm/auth";
import type { Pool } from "pg";
import { z } from "zod";
import { PG_POOL } from "../db/database.module";
import { parseBody } from "../portal/zod";
import { AuthErrorFilter } from "./auth-error.filter";
import { AuthGuard, CurrentUser } from "./auth.guard";
import { SuperAdminGuard } from "./roles.guard";

/**
 * Super Admin Panel backend (§19.2): manage tenants/subscriptions,
 * global platform health. Every mutation is audited at platform level.
 */
@Controller("admin")
@UseGuards(AuthGuard, SuperAdminGuard)
@UseFilters(AuthErrorFilter)
export class AdminController {
  constructor(@Inject(PG_POOL) private readonly pool: Pool) {}

  @Get("tenants")
  async tenants() {
    const res = await this.pool.query(
      `SELECT t.id, t.name, t.slug, t.status, t.plan, t.created_at,
              (SELECT count(*) FROM tenant_users tu WHERE tu.tenant_id = t.id)::int AS members,
              (SELECT count(*) FROM integrity_alerts ia
               WHERE ia.tenant_id = t.id AND ia.status = 'OPEN')::int AS open_alerts
       FROM tenants t ORDER BY t.id`,
    );
    return res.rows;
  }

  @Post("tenants")
  async provision(
    @CurrentUser() principal: SessionPrincipal,
    @Body() body: unknown,
  ) {
    const dto = parseBody(
      z.object({
        name: z.string().min(1),
        slug: z.string().regex(/^[a-z0-9][a-z0-9-]{1,58}$/),
      }),
      body,
    );
    const res = await this.pool.query<{ id: number }>(
      "SELECT provision_tenant($1, $2) AS id",
      [dto.name, dto.slug],
    );
    const tenantId = res.rows[0]!.id;
    await this.audit(principal.userId, tenantId, "TENANT_PROVISIONED", dto);
    return { tenantId };
  }

  @Post("tenants/:id/status")
  async setStatus(
    @CurrentUser() principal: SessionPrincipal,
    @Param("id") id: string,
    @Body() body: unknown,
  ) {
    const dto = parseBody(
      z.object({ status: z.enum(["ACTIVE", "SUSPENDED", "CANCELLED"]) }),
      body,
    );
    const tenantId = Number(id);
    const res = await this.pool.query(
      "UPDATE tenants SET status=$2 WHERE id=$1 RETURNING id",
      [tenantId, dto.status],
    );
    if (!res.rows[0]) return { updated: false };
    await this.audit(principal.userId, tenantId, "TENANT_STATUS_CHANGED", dto);
    return { updated: true, status: dto.status };
  }

  private async audit(
    userId: number,
    tenantId: number,
    action: string,
    after: unknown,
  ): Promise<void> {
    await this.pool.query(
      `INSERT INTO audit_log (tenant_id, user_id, action, entity, after_json)
       VALUES ($1,$2,$3,'tenants',$4)`,
      [tenantId, userId, action, JSON.stringify(after)],
    );
  }
}
