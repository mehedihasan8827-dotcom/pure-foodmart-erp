import {
  BadRequestException,
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Inject,
  Injectable,
  SetMetadata,
} from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import type { SessionPrincipal, TenantRole } from "@pfm/auth";
import type { Pool } from "pg";
import { PG_PLATFORM_POOL } from "../db/database.module";

export const ROLES_KEY = "pfm:roles";

/** Allowed tenant roles for a controller/route (§19.2 role matrix). */
export const Roles = (...roles: TenantRole[]) => SetMetadata(ROLES_KEY, roles);

/**
 * Tenant scoping + role enforcement. Runs after AuthGuard:
 *  - X-Tenant-Id selects which of the user's tenants this request targets
 *  - membership must exist, tenant must be ACTIVE, role must be allowed
 *  - Super Admins bypass membership (platform overrides) — every mutating
 *    override is written to the audit log (§19.2)
 *
 * The only query this guard runs is the SA_OVERRIDE audit insert below,
 * reached exclusively when principal.isSuperAdmin is true. It writes a
 * real (non-null) tenant_id with no app.tenant_id session context, which
 * pfm_app's RLS can never satisfy — so it uses the BYPASSRLS platform pool.
 * Regular tenant members never hit this branch, so their requests still
 * run entirely under RLS as before.
 */
@Injectable()
export class TenantRoleGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    @Inject(PG_PLATFORM_POOL) private readonly pool: Pool,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest();
    const principal = req.auth as SessionPrincipal | undefined;
    if (!principal) throw new ForbiddenException("No session principal");

    const raw = req.headers["x-tenant-id"];
    const tenantId = Number(Array.isArray(raw) ? raw[0] : raw);
    if (!Number.isInteger(tenantId) || tenantId <= 0) {
      throw new BadRequestException("X-Tenant-Id header required");
    }

    if (principal.isSuperAdmin) {
      if (req.method !== "GET") {
        await this.pool.query(
          `INSERT INTO audit_log (tenant_id, user_id, action, entity, after_json)
           VALUES ($1,$2,'SA_OVERRIDE','http',$3)`,
          [tenantId, principal.userId, JSON.stringify({ method: req.method, url: req.url })],
        );
      }
      req.tenantId = tenantId;
      return true;
    }

    const membership = principal.memberships.find((m) => m.tenantId === tenantId);
    if (!membership) throw new ForbiddenException("No access to this tenant");
    if (membership.tenantStatus !== "ACTIVE") {
      throw new ForbiddenException(`Tenant is ${membership.tenantStatus}`);
    }
    const allowed = this.reflector.getAllAndOverride<TenantRole[] | undefined>(
      ROLES_KEY,
      [context.getHandler(), context.getClass()],
    );
    if (allowed && !allowed.includes(membership.role)) {
      throw new ForbiddenException(
        `Requires role: ${allowed.join(" or ")} (you are ${membership.role})`,
      );
    }
    req.tenantId = tenantId;
    return true;
  }
}

/** Platform staff only (Super Admin Panel). */
@Injectable()
export class SuperAdminGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const req = context.switchToHttp().getRequest();
    const principal = req.auth as SessionPrincipal | undefined;
    if (!principal?.isSuperAdmin) {
      throw new ForbiddenException("Super admin only");
    }
    return true;
  }
}
