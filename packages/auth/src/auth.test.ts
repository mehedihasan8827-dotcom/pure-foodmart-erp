/**
 * B7 acceptance gate: Argon2id round-trips, TOTP matches the RFC 6238
 * published test vectors, sessions expire/revoke correctly, login
 * enforces enrolled 2FA, and memberships carry the role matrix.
 */
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AuthError } from "./errors";
import { hashPassword, verifyPassword } from "./password";
import {
  login,
  revokeSession,
  validateSession,
} from "./sessions";
import {
  base32Decode,
  base32Encode,
  generateTotpSecret,
  otpauthUri,
  totp,
  verifyTotp,
} from "./totp";
import {
  bootstrapSuperAdmin,
  createUser,
  enableTotp,
  inviteToTenant,
  requireFreshTotp,
} from "./users";

const pool = new Pool({
  connectionString:
    process.env.DATABASE_URL ??
    "postgres://erp:erp_local_dev@localhost:5432/pure_foodmart_erp",
  max: 10,
});

let T1 = 0;

beforeAll(async () => {
  const found = await pool.query<{ id: number }>(
    "SELECT id FROM tenants WHERE slug='pure-foodmart'",
  );
  T1 = found.rows[0]
    ? found.rows[0].id
    : (await pool.query<{ id: number }>(
        "SELECT provision_tenant('Pure Foodmart','pure-foodmart') AS id",
      )).rows[0]!.id;
  // No TRUNCATE ... CASCADE here: users is referenced by
  // fiscal_periods.locked_by, and a cascade would wipe periods → ledgers.
  await pool.query("DELETE FROM audit_log");
  await pool.query("DELETE FROM integrity_alerts");
  await pool.query("TRUNCATE sessions");
  await pool.query("DELETE FROM tenant_users");
  await pool.query(
    "UPDATE fiscal_periods SET is_locked=FALSE, locked_at=NULL, locked_by=NULL",
  );
  await pool.query("DELETE FROM users");
  await pool.query("ALTER SEQUENCE users_id_seq RESTART WITH 1");
});
afterAll(async () => {
  await pool.end();
});

describe("TOTP (RFC 6238)", () => {
  // RFC 6238 Appendix B vectors: SHA-1, 8 digits, ASCII secret "12345678901234567890"
  const RFC_SECRET = base32Encode(Buffer.from("12345678901234567890", "ascii"));
  const vectors: [number, string][] = [
    [59, "94287082"],
    [1111111109, "07081804"],
    [1234567890, "89005924"],
    [2000000000, "69279037"],
  ];

  it("matches every published RFC test vector", () => {
    for (const [seconds, expected] of vectors) {
      expect(totp(RFC_SECRET, { timeMs: seconds * 1000, digits: 8 })).toBe(expected);
    }
  });

  it("verifies within the drift window and rejects outside it", () => {
    const t = 1111111109 * 1000;
    expect(verifyTotp(RFC_SECRET, "07081804", { timeMs: t, digits: 8 })).toBe(true);
    // one step earlier still inside ±1 window
    expect(verifyTotp(RFC_SECRET, "07081804", { timeMs: t + 30_000, digits: 8 })).toBe(true);
    // two steps away → rejected
    expect(verifyTotp(RFC_SECRET, "07081804", { timeMs: t + 61_000, digits: 8 })).toBe(false);
    expect(verifyTotp(RFC_SECRET, "not-a-code", { timeMs: t })).toBe(false);
  });

  it("base32 round-trips and produces scannable provisioning URIs", () => {
    const secret = generateTotpSecret();
    expect(secret).toMatch(/^[A-Z2-7]{32}$/);
    expect(base32Encode(base32Decode(secret))).toBe(secret);
    const uri = otpauthUri("Pure Foodmart ERP", "owner@pf.test", secret);
    expect(uri).toContain("otpauth://totp/");
    expect(uri).toContain(`secret=${secret}`);
  });
});

describe("passwords (Argon2id)", () => {
  it("hashes, verifies, and rejects wrong/short passwords", async () => {
    const hash = await hashPassword("correct horse battery");
    expect(hash).toContain("$argon2id$");
    expect(await verifyPassword(hash, "correct horse battery")).toBe(true);
    expect(await verifyPassword(hash, "wrong password!")).toBe(false);
    await expect(hashPassword("short")).rejects.toThrow(/at least 10/);
  });
});

describe("users, sessions, and the login flow", () => {
  it("bootstrap works once and only once", async () => {
    const first = await bootstrapSuperAdmin(pool, {
      email: "root@pf.test", fullName: "Platform Root", password: "super-secret-pw",
    });
    expect(first.userId).toBe(1);
    await expect(
      bootstrapSuperAdmin(pool, {
        email: "second@pf.test", fullName: "No", password: "another-secret",
      }),
    ).rejects.toThrow(/before any user exists/);
  });

  it("logs in, validates, revokes; rejects bad credentials", async () => {
    const { token, principal } = await login(pool, {
      email: "ROOT@pf.test", password: "super-secret-pw",
    });
    expect(principal.isSuperAdmin).toBe(true);
    const validated = await validateSession(pool, token);
    expect(validated.email).toBe("root@pf.test");

    await expect(
      login(pool, { email: "root@pf.test", password: "nope-nope-nope" }),
    ).rejects.toThrow(AuthError);

    await revokeSession(pool, token);
    await expect(validateSession(pool, token)).rejects.toThrow(/expired or revoked/);
    await expect(validateSession(pool, "junk-token")).rejects.toThrow(AuthError);
  });

  it("expired sessions are dead even when not revoked", async () => {
    const { token } = await login(pool, {
      email: "root@pf.test", password: "super-secret-pw",
    });
    await pool.query(
      "UPDATE sessions SET expires_at = now() - interval '1 minute' WHERE revoked_at IS NULL",
    );
    await expect(validateSession(pool, token)).rejects.toThrow(/expired/);
  });

  it("membership invites carry roles; duplicate invite updates the role", async () => {
    const invited = await inviteToTenant(pool, {
      email: "accountant@pf.test", fullName: "Ms. Hisab",
      temporaryPassword: "temp-password-1", tenantId: T1,
      role: "ACCOUNTANT", invitedBy: 1,
    });
    expect(invited.created).toBe(true);
    const { principal } = await login(pool, {
      email: "accountant@pf.test", password: "temp-password-1",
    });
    expect(principal.memberships).toEqual([
      expect.objectContaining({ tenantId: T1, role: "ACCOUNTANT", tenantStatus: "ACTIVE" }),
    ]);

    const again = await inviteToTenant(pool, {
      email: "accountant@pf.test", fullName: "Ms. Hisab",
      temporaryPassword: "irrelevant-here", tenantId: T1,
      role: "VIEWER", invitedBy: 1,
    });
    expect(again.created).toBe(false);
    const demoted = await login(pool, {
      email: "accountant@pf.test", password: "temp-password-1",
    });
    expect(demoted.principal.memberships[0]!.role).toBe("VIEWER");
  });

  it("enforces TOTP after enrollment, including the fresh-2FA gate", async () => {
    const { userId } = await createUser(pool, {
      email: "owner@pf.test", fullName: "Owner", password: "owner-password-1",
    });
    await inviteToTenant(pool, {
      email: "owner@pf.test", fullName: "Owner", temporaryPassword: "x".repeat(10),
      tenantId: T1, role: "TENANT_ADMIN", invitedBy: 1,
    });

    // The fresh-2FA gate refuses before enrollment (§15: 2FA mandatory
    // for period lock and similar operations).
    await expect(requireFreshTotp(pool, userId, "123456")).rejects.toThrow(
      /must be enabled/,
    );

    const secret = generateTotpSecret();
    await expect(enableTotp(pool, userId, secret, "000000")).rejects.toThrow(
      /does not match/,
    );
    await enableTotp(pool, userId, secret, totp(secret));

    // Password alone no longer logs in.
    await expect(
      login(pool, { email: "owner@pf.test", password: "owner-password-1" }),
    ).rejects.toMatchObject({ code: "TOTP_REQUIRED" });
    await expect(
      login(pool, {
        email: "owner@pf.test", password: "owner-password-1", totpCode: "999999",
      }),
    ).rejects.toMatchObject({ code: "INVALID_TOTP" });
    const ok = await login(pool, {
      email: "owner@pf.test", password: "owner-password-1", totpCode: totp(secret),
    });
    expect(ok.principal.totpEnabled).toBe(true);

    await requireFreshTotp(pool, userId, totp(secret)); // resolves
    await expect(requireFreshTotp(pool, userId, "000000")).rejects.toMatchObject({
      code: "INVALID_TOTP",
    });
  });
});
