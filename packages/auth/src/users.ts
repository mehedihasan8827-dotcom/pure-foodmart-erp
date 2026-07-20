import type { Pool } from "pg";
import { AuthError } from "./errors";
import { hashPassword } from "./password";
import { verifyTotp } from "./totp";

export type TenantRole = "TENANT_ADMIN" | "ACCOUNTANT" | "STAFF" | "VIEWER";

export interface CreateUserInput {
  email: string;
  fullName: string;
  password: string;
  isSuperAdmin?: boolean;
}

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export async function createUser(
  pool: Pool,
  input: CreateUserInput,
): Promise<{ userId: number }> {
  const email = input.email.trim().toLowerCase();
  if (!EMAIL_PATTERN.test(email)) throw new AuthError("VALIDATION", "Invalid email");
  if (!input.fullName.trim()) throw new AuthError("VALIDATION", "Full name required");
  const passwordHash = await hashPassword(input.password);
  try {
    const res = await pool.query<{ id: number }>(
      `INSERT INTO users (email, full_name, password_hash, is_super_admin)
       VALUES ($1,$2,$3,$4) RETURNING id`,
      [email, input.fullName.trim(), passwordHash, input.isSuperAdmin ?? false],
    );
    return { userId: res.rows[0]!.id };
  } catch (err) {
    if ((err as { code?: string }).code === "23505") {
      throw new AuthError("USER_EXISTS", `A user with email ${email} already exists`);
    }
    throw err;
  }
}

/**
 * First-run bootstrap: creates the FIRST super admin, and only while the
 * users table is completely empty. After that the endpoint is dead.
 */
export async function bootstrapSuperAdmin(
  pool: Pool,
  input: Omit<CreateUserInput, "isSuperAdmin">,
): Promise<{ userId: number }> {
  const count = await pool.query<{ n: string }>("SELECT count(*) AS n FROM users");
  if (Number(count.rows[0]!.n) > 0) {
    throw new AuthError("VALIDATION", "Bootstrap is only available before any user exists");
  }
  const created = await createUser(pool, { ...input, isSuperAdmin: true });
  await pool.query(
    "INSERT INTO audit_log (user_id, action, entity, entity_id) VALUES ($1::int,'BOOTSTRAP_SUPER_ADMIN','users',$1::bigint)",
    [created.userId],
  );
  return created;
}

/** Tenant admin invites a member: find-or-create the user + upsert membership. */
export async function inviteToTenant(
  pool: Pool,
  input: {
    email: string;
    fullName: string;
    temporaryPassword: string;
    tenantId: number;
    role: TenantRole;
    invitedBy: number;
  },
): Promise<{ userId: number; created: boolean }> {
  const email = input.email.trim().toLowerCase();
  const existing = await pool.query<{ id: number }>(
    "SELECT id FROM users WHERE email = $1",
    [email],
  );
  let userId: number;
  let created = false;
  if (existing.rows[0]) {
    userId = existing.rows[0].id;
  } else {
    ({ userId } = await createUser(pool, {
      email,
      fullName: input.fullName,
      password: input.temporaryPassword,
    }));
    created = true;
  }
  // tenant_users is un-policied (see 011_users_audit.sql), but audit_log is
  // RLS-enforced and this writes a real tenant_id — set app.tenant_id for
  // this transaction so pfm_app's RLS check (tenant_id = app_tenant_id())
  // can actually pass. Without this, every invite (not just super-admin
  // ones) would 500 on the audit insert.
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT set_config('app.tenant_id', $1, true)", [
      String(input.tenantId),
    ]);
    await client.query(
      `INSERT INTO tenant_users (user_id, tenant_id, role, invited_by)
       VALUES ($1,$2,$3,$4)
       ON CONFLICT (user_id, tenant_id) DO UPDATE SET role = EXCLUDED.role`,
      [userId, input.tenantId, input.role, input.invitedBy],
    );
    await client.query(
      `INSERT INTO audit_log (tenant_id, user_id, action, entity, entity_id, after_json)
       VALUES ($1,$2,'MEMBER_INVITED','tenant_users',$3,$4)`,
      [input.tenantId, input.invitedBy, userId, JSON.stringify({ email, role: input.role })],
    );
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
  return { userId, created };
}

/** Verify a fresh TOTP code for a sensitive operation (period lock, §15). */
export async function requireFreshTotp(
  pool: Pool,
  userId: number,
  code: string | null | undefined,
): Promise<void> {
  const res = await pool.query<{ totp_secret: string | null }>(
    "SELECT totp_secret FROM users WHERE id = $1 AND is_active",
    [userId],
  );
  const secret = res.rows[0]?.totp_secret;
  if (!secret) {
    throw new AuthError(
      "TOTP_NOT_ENABLED",
      "Two-factor authentication must be enabled for this operation (§15)",
    );
  }
  if (!code || !verifyTotp(secret, code)) {
    throw new AuthError("INVALID_TOTP", "A valid 2FA code is required for this operation");
  }
}

export async function enableTotp(
  pool: Pool,
  userId: number,
  secretBase32: string,
  code: string,
): Promise<void> {
  const existing = await pool.query<{ totp_secret: string | null }>(
    "SELECT totp_secret FROM users WHERE id = $1",
    [userId],
  );
  if (existing.rows[0]?.totp_secret) {
    throw new AuthError("VALIDATION", "TOTP is already enabled");
  }
  if (!verifyTotp(secretBase32, code)) {
    throw new AuthError("INVALID_TOTP", "Code does not match the provided secret");
  }
  await pool.query("UPDATE users SET totp_secret = $2 WHERE id = $1", [
    userId,
    secretBase32,
  ]);
  await pool.query(
    "INSERT INTO audit_log (user_id, action, entity, entity_id) VALUES ($1::int,'TOTP_ENABLED','users',$1::bigint)",
    [userId],
  );
}
