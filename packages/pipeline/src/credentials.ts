import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
} from "node:crypto";

/**
 * Merchant API credential sealing (blueprint §19.3).
 * AES-256-GCM under the platform master key (host secret manager, env
 * CREDENTIALS_MASTER_KEY as 64 hex chars). Ciphertext layout, base64:
 * iv(12) ‖ authTag(16) ‖ ciphertext. Plaintext never reaches the DB;
 * GCM auth means any tampering with stored ciphertext fails loudly.
 */

export class CredentialsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CredentialsError";
  }
}

function keyFromHex(masterKeyHex: string): Buffer {
  if (!/^[0-9a-fA-F]{64}$/.test(masterKeyHex)) {
    throw new CredentialsError(
      "master key must be 64 hex chars (32 bytes) — generate with: openssl rand -hex 32",
    );
  }
  return Buffer.from(masterKeyHex, "hex");
}

export function sealCredentials(
  masterKeyHex: string,
  credentials: Record<string, string>,
): string {
  const key = keyFromHex(masterKeyHex);
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ciphertext = Buffer.concat([
    cipher.update(JSON.stringify(credentials), "utf8"),
    cipher.final(),
  ]);
  return Buffer.concat([iv, cipher.getAuthTag(), ciphertext]).toString("base64");
}

export function openCredentials(
  masterKeyHex: string,
  sealed: string,
): Record<string, string> {
  const key = keyFromHex(masterKeyHex);
  const raw = Buffer.from(sealed, "base64");
  if (raw.length < 12 + 16 + 1) {
    throw new CredentialsError("sealed credentials too short / corrupted");
  }
  const iv = raw.subarray(0, 12);
  const tag = raw.subarray(12, 28);
  const ciphertext = raw.subarray(28);
  const decipher = createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(tag);
  try {
    const plain = Buffer.concat([
      decipher.update(ciphertext),
      decipher.final(),
    ]).toString("utf8");
    return JSON.parse(plain) as Record<string, string>;
  } catch {
    throw new CredentialsError(
      "credential unsealing failed — wrong master key or tampered ciphertext",
    );
  }
}
