import { hash, verify } from "@node-rs/argon2";
import { AuthError } from "./errors";

/**
 * Argon2id (the @node-rs default) with explicit parameters ≥ OWASP
 * recommendations: 19 MiB memory, 2 iterations, parallelism 1.
 */
const ARGON2_OPTIONS = {
  memoryCost: 19_456,
  timeCost: 2,
  parallelism: 1,
};

const MIN_PASSWORD_LENGTH = 10;

export function assertPasswordPolicy(password: string): void {
  if (password.length < MIN_PASSWORD_LENGTH) {
    throw new AuthError(
      "VALIDATION",
      `Password must be at least ${MIN_PASSWORD_LENGTH} characters`,
    );
  }
}

export async function hashPassword(password: string): Promise<string> {
  assertPasswordPolicy(password);
  return hash(password, ARGON2_OPTIONS);
}

export async function verifyPassword(
  passwordHash: string,
  password: string,
): Promise<boolean> {
  try {
    return await verify(passwordHash, password);
  } catch {
    return false;
  }
}
