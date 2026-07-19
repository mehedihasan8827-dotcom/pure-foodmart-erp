import { createParamDecorator, ExecutionContext } from "@nestjs/common";

/**
 * Injects the tenant id resolved and authorized by TenantRoleGuard
 * (../auth/roles.guard). The B6 dev-mode header guard is gone: since B7,
 * X-Tenant-Id is only honored for authenticated members of that tenant
 * (or audited super-admin overrides).
 */
export const TenantId = createParamDecorator(
  (_data: unknown, context: ExecutionContext): number =>
    context.switchToHttp().getRequest().tenantId as number,
);
