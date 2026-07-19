import {
  Body,
  Controller,
  Get,
  HttpCode,
  Inject,
  Post,
  Res,
  Req,
  UseFilters,
  UseGuards,
} from "@nestjs/common";
import {
  bootstrapSuperAdmin,
  enableTotp,
  generateTotpSecret,
  login,
  otpauthUri,
  revokeSession,
  type SessionPrincipal,
} from "@pfm/auth";
import type { Pool } from "pg";
import { z } from "zod";
import { PG_POOL } from "../db/database.module";
import { parseBody } from "../portal/zod";
import { AuthErrorFilter } from "./auth-error.filter";
import {
  AuthGuard,
  CurrentUser,
  extractToken,
  sessionClearCookie,
  sessionSetCookie,
} from "./auth.guard";

const TOTP_ISSUER = "Pure Foodmart ERP";

@Controller("auth")
@UseFilters(AuthErrorFilter)
export class AuthController {
  constructor(@Inject(PG_POOL) private readonly pool: Pool) {}

  /** One-time first-run: creates the FIRST super admin, then goes dead. */
  @Post("bootstrap")
  bootstrap(@Body() body: unknown) {
    const dto = parseBody(
      z.object({
        email: z.string().email(),
        fullName: z.string().min(1),
        password: z.string().min(10),
      }),
      body,
    );
    return bootstrapSuperAdmin(this.pool, dto);
  }

  @Post("login")
  @HttpCode(200)
  async login(
    @Body() body: unknown,
    @Req() req: { ip?: string; headers: Record<string, unknown> },
    @Res({ passthrough: true }) res: { setHeader: (k: string, v: string) => void },
  ) {
    const dto = parseBody(
      z.object({
        email: z.string().email(),
        password: z.string().min(1),
        totpCode: z.string().optional(),
      }),
      body,
    );
    const result = await login(this.pool, {
      ...dto,
      ip: req.ip ?? null,
      userAgent: (req.headers["user-agent"] as string) ?? null,
    });
    res.setHeader("Set-Cookie", sessionSetCookie(result.token));
    // Token also returned for Bearer clients (Android app, B12).
    return { token: result.token, principal: result.principal };
  }

  @Post("logout")
  @HttpCode(200)
  async logout(
    @Req() req: { headers: Record<string, unknown> },
    @Res({ passthrough: true }) res: { setHeader: (k: string, v: string) => void },
  ) {
    const token = extractToken(req);
    if (token) await revokeSession(this.pool, token);
    res.setHeader("Set-Cookie", sessionClearCookie());
    return { loggedOut: true };
  }

  @Get("me")
  @UseGuards(AuthGuard)
  me(@CurrentUser() principal: SessionPrincipal) {
    return principal;
  }

  @Post("totp/setup")
  @UseGuards(AuthGuard)
  totpSetup(@CurrentUser() principal: SessionPrincipal) {
    const secret = generateTotpSecret();
    return {
      secret,
      uri: otpauthUri(TOTP_ISSUER, principal.email, secret),
      note: "Scan, then confirm via POST /auth/totp/enable {secret, code}",
    };
  }

  @Post("totp/enable")
  @UseGuards(AuthGuard)
  async totpEnable(
    @CurrentUser() principal: SessionPrincipal,
    @Body() body: unknown,
  ) {
    const dto = parseBody(
      z.object({ secret: z.string().min(16), code: z.string().min(6) }),
      body,
    );
    await enableTotp(this.pool, principal.userId, dto.secret, dto.code);
    return { totpEnabled: true };
  }
}
