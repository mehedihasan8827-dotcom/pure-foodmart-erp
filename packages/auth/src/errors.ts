export type AuthErrorCode =
  | "INVALID_CREDENTIALS"
  | "TOTP_REQUIRED"
  | "INVALID_TOTP"
  | "TOTP_NOT_ENABLED"
  | "SESSION_INVALID"
  | "USER_EXISTS"
  | "VALIDATION";

export class AuthError extends Error {
  constructor(
    readonly code: AuthErrorCode,
    message?: string,
  ) {
    super(message ?? code);
    this.name = "AuthError";
  }
}
