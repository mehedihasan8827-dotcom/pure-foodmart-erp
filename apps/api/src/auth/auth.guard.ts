import {
  CanActivate,
  createParamDecorator,
  ExecutionContext,
  Inject,
  Injectable,
  UnauthorizedException,
} from "@nestjs/common";
import { validateSession, type SessionPrincipal } from "@pfm/auth";
import type { Pool } from "pg";
import { PG_PLATFORM_POOL, PG_POOL } from "../db/database.module";

export const SESSION_COOKIE = "pfm_session";

export function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!header) return out;
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq === -1) continue;
    out[part.slice(0, eq).trim()] = decodeURIComponent(part.slice(eq + 1).trim());
  }
  return out;
}

export function sessionSetCookie(token: string): string {
  const secure = process.env.NODE_ENV === "production" ? "; Secure" : "";
  return `${SESSION_COOKIE}=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${7 * 24 * 3600}${secure}`;
}

export function sessionClearCookie(): string {
  return `${SESSION_COOKIE}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0`;
}

export function extractToken(req: {
  headers: Record<string, unknown>;
}): string | null {
  const cookies = parseCookies(req.headers["cookie"] as string | undefined);
  if (cookies[SESSION_COOKIE]) return cookies[SESSION_COOKIE];
  const authz = req.headers["authorization"];
  if (typeof authz === "string" && authz.startsWith("Bearer ")) {
    return authz.slice("Bearer ".length).trim();
  }
  return null;
}

/**
 * Session authentication (B7): HttpOnly cookie for the web app, Bearer
 * token for the Android app / API clients. Attaches the SessionPrincipal
 * (user + memberships) to the request.
 */
@Injectable()
export class AuthGuard implements CanActivate {
  constructor(
    @Inject(PG_POOL) private readonly pool: Pool,
    @Inject(PG_PLATFORM_POOL) private readonly platformPool: Pool,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest();
    const token = extractToken(req);
    if (!token) throw new UnauthorizedException("Authentication required");
    try {
      req.auth = await validateSession(this.pool, this.platformPool, token);
      req.sessionToken = token;
      return true;
    } catch {
      throw new UnauthorizedException("Session expired or invalid");
    }
  }
}

export const CurrentUser = createParamDecorator(
  (_data: unknown, context: ExecutionContext): SessionPrincipal =>
    context.switchToHttp().getRequest().auth as SessionPrincipal,
);
