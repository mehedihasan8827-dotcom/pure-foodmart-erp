import {
  BadRequestException,
  CanActivate,
  createParamDecorator,
  ExecutionContext,
  Injectable,
} from "@nestjs/common";

/**
 * DEV-ONLY tenant scoping: trusts the X-Tenant-Id header.
 * B7 replaces this with session auth resolving tenant membership + role
 * from tenant_users — this guard exists so the portal endpoints are
 * exercisable end-to-end before the auth batch lands. Do NOT expose
 * publicly until B7 ships.
 */
@Injectable()
export class TenantContextGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const req = context.switchToHttp().getRequest();
    const raw = req.headers["x-tenant-id"];
    const tenantId = Number(Array.isArray(raw) ? raw[0] : raw);
    if (!Number.isInteger(tenantId) || tenantId <= 0) {
      throw new BadRequestException(
        "X-Tenant-Id header required (dev mode; replaced by auth in B7)",
      );
    }
    req.tenantId = tenantId;
    return true;
  }
}

export const TenantId = createParamDecorator(
  (_data: unknown, context: ExecutionContext): number =>
    context.switchToHttp().getRequest().tenantId as number,
);
