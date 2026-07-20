import { createHash, randomBytes } from "node:crypto";
import type { Pool } from "pg";
import { AuthError } from "./errors";
import { verifyPassword } from "./password";
import { verifyTotp } from "./totp";
import type { TenantRole } from "./users";

const SESSION_TTL_DAYS = 7;
const TOUCH_INTERVAL_MS = 5 * 60 * 1000;

export interface Membership {
  tenantId: number;
  tenantName: string;
  tenantStatus: string;
  role: TenantRole;
}

export interface SessionPrincipal {
  userId: number;
  email: string;
  fullName: string;
  isSuperAdmin: boolean;
  totpEnabled: boolean;
  memberships: Membership[];
}

export interface LoginInput {
  email: string;
  password: string;
  totpCode?: string | null;
  ip?: string | null;
  userAgent?: string | null;
}

export interface LoginResult {
  token: string;
  principal: SessionPrincipal;
}

function sha256(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

/**
 * Credential + (mandatory when enrolled) TOTP verification → opaque
 * session token. Only the token's hash is persisted; failures are
 * audited without revealing which factor failed to the caller beyond
 * the distinction the UX needs (TOTP_REQUIRED).
 */
export async function login(
  pool: Pool,
  platformPool: Pool,
  input: LoginInput,
): Promise<LoginResult> {
  const email = input.email.trim().toLowerCase();
  const res = await pool.query<{
    id: number;
    password_hash: string;
    totp_secret: string | null;
  }>(
    "SELECT id, password_hash, totp_secret FROM users WHERE email = $1 AND is_active",
    [email],
  );
  const user = res.rows[0];
  const passwordOk = user
    ? await verifyPassword(user.password_hash, input.password)
    : false;
  if (!user || !passwordOk) {
    await pool.query(
      "INSERT INTO audit_log (action, entity, after_json) VALUES ('LOGIN_FAILED','users',$1)",
      [JSON.stringify({ email })],
    );
    throw new AuthError("INVALID_CREDENTIALS", "Invalid email or password");
  }
  if (user.totp_secret) {
    if (!input.totpCode) throw new AuthError("TOTP_REQUIRED", "2FA code required");
    if (!verifyTotp(user.totp_secret, input.totpCode)) {
      await pool.query(
        "INSERT INTO audit_log (user_id, action, entity, entity_id) VALUES ($1::int,'LOGIN_TOTP_FAILED','users',$1::bigint)",
        [user.id],
      );
      throw new AuthError("INVALID_TOTP", "Invalid 2FA code");
    }
  }

  const token = randomBytes(32).toString("hex");
  await pool.query(
    `INSERT INTO sessions (token_hash, user_id, expires_at, ip, user_agent)
     VALUES ($1,$2, now() + interval '${SESSION_TTL_DAYS} days', $3, $4)`,
    [sha256(token), user.id, input.ip ?? null, input.userAgent ?? null],
  );
  await pool.query(
    "INSERT INTO audit_log (user_id, action, entity, entity_id) VALUES ($1::int,'LOGIN','users',$1::bigint)",
    [user.id],
  );
  return { token, principal: await loadPrincipal(pool, platformPool, user.id) };
}

export async function validateSession(
  pool: Pool,
  platformPool: Pool,
  token: string,
): Promise<SessionPrincipal> {
  const res = await pool.query<{
    id: string;
    user_id: number;
    last_used_at: string;
  }>(
    `SELECT s.id, s.user_id, s.last_used_at::text
     FROM sessions s JOIN users u ON u.id = s.user_id
     WHERE s.token_hash = $1
       AND s.revoked_at IS NULL
       AND s.expires_at > now()
       AND u.is_active`,
    [sha256(token)],
  );
  const row = res.rows[0];
  if (!row) throw new AuthError("SESSION_INVALID", "Session expired or revoked");
  if (Date.now() - new Date(row.last_used_at).getTime() > TOUCH_INTERVAL_MS) {
    await pool.query("UPDATE sessions SET last_used_at = now() WHERE id = $1", [row.id]);
  }
  return loadPrincipal(pool, platformPool, row.user_id);
}

export async function revokeSession(pool: Pool, token: string): Promise<void> {
  await pool.query(
    "UPDATE sessions SET revoked_at = now() WHERE token_hash = $1 AND revoked_at IS NULL",
    [sha256(token)],
  );
}

/**
 * The memberships join reads `tenants`, which is RLS-protected
 * (`id = app_tenant_id()`) — but this runs before any single tenant
 * context is chosen (a user's memberships can span many tenants), so no
 * app.tenant_id value could ever be "correct" here under pfm_app. The
 * query itself is already scoped to the caller's own validated userId
 * (not attacker-influenced), so RLS wasn't providing meaningful
 * protection for this specific read — it was only breaking it. Runs on
 * the BYPASSRLS platform pool for that reason; `users` has no RLS so
 * stays on the regular pool.
 */
async function loadPrincipal(
  pool: Pool,
  platformPool: Pool,
  userId: number,
): Promise<SessionPrincipal> {
  const user = await pool.query<{
    id: number;
    email: string;
    full_name: string;
    is_super_admin: boolean;
    totp_secret: string | null;
  }>(
    "SELECT id, email, full_name, is_super_admin, totp_secret FROM users WHERE id = $1",
    [userId],
  );
  const u = user.rows[0]!;
  const memberships = await platformPool.query<{
    tenant_id: number;
    role: TenantRole;
    name: string;
    status: string;
  }>(
    `SELECT tu.tenant_id, tu.role, t.name, t.status
     FROM tenant_users tu JOIN tenants t ON t.id = tu.tenant_id
     WHERE tu.user_id = $1 ORDER BY tu.tenant_id`,
    [userId],
  );
  return {
    userId: u.id,
    email: u.email,
    fullName: u.full_name,
    isSuperAdmin: u.is_super_admin,
    totpEnabled: u.totp_secret !== null,
    memberships: memberships.rows.map((m) => ({
      tenantId: m.tenant_id,
      tenantName: m.name,
      tenantStatus: m.status,
      role: m.role,
    })),
  };
}
