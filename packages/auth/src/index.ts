/**
 * @pfm/auth — platform authentication & RBAC primitives (blueprint §15,
 * §19.2): Argon2id passwords, RFC 6238 TOTP, hashed DB sessions, tenant
 * memberships, and the fresh-2FA gate for sensitive operations.
 */
export { AuthError, type AuthErrorCode } from "./errors";
export {
  assertPasswordPolicy,
  hashPassword,
  verifyPassword,
} from "./password";
export {
  base32Decode,
  base32Encode,
  generateTotpSecret,
  hotp,
  otpauthUri,
  totp,
  verifyTotp,
} from "./totp";
export {
  bootstrapSuperAdmin,
  createUser,
  enableTotp,
  inviteToTenant,
  requireFreshTotp,
  type CreateUserInput,
  type TenantRole,
} from "./users";
export {
  login,
  revokeSession,
  validateSession,
  type LoginInput,
  type LoginResult,
  type Membership,
  type SessionPrincipal,
} from "./sessions";
