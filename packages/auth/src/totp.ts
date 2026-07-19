import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

/**
 * RFC 6238 TOTP (SHA-1, 6 digits, 30 s step) — dependency-free and
 * verified against the RFC's published test vectors in totp tests.
 * Compatible with Google Authenticator / Authy / 1Password.
 */

const B32_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

export function base32Encode(buf: Buffer): string {
  let bits = 0;
  let value = 0;
  let out = "";
  for (const byte of buf) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += B32_ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += B32_ALPHABET[(value << (5 - bits)) & 31];
  return out;
}

export function base32Decode(str: string): Buffer {
  const clean = str.toUpperCase().replace(/=+$/, "").replace(/\s+/g, "");
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const ch of clean) {
    const idx = B32_ALPHABET.indexOf(ch);
    if (idx === -1) throw new Error(`invalid base32 character: ${ch}`);
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

export function hotp(secret: Buffer, counter: bigint, digits = 6): string {
  const msg = Buffer.alloc(8);
  msg.writeBigUInt64BE(counter);
  const mac = createHmac("sha1", secret).update(msg).digest();
  const offset = mac[mac.length - 1]! & 0x0f;
  const code =
    ((mac[offset]! & 0x7f) << 24) |
    (mac[offset + 1]! << 16) |
    (mac[offset + 2]! << 8) |
    mac[offset + 3]!;
  return String(code % 10 ** digits).padStart(digits, "0");
}

export interface TotpOptions {
  timeMs?: number;
  stepSec?: number;
  digits?: number;
}

export function totp(secretBase32: string, opts: TotpOptions = {}): string {
  const timeMs = opts.timeMs ?? Date.now();
  const step = opts.stepSec ?? 30;
  const counter = BigInt(Math.floor(timeMs / 1000 / step));
  return hotp(base32Decode(secretBase32), counter, opts.digits ?? 6);
}

/** Accept the current step ± window steps (default ±1 = 90 s of drift). */
export function verifyTotp(
  secretBase32: string,
  code: string,
  opts: TotpOptions & { window?: number } = {},
): boolean {
  if (!/^\d{6,8}$/.test(code)) return false;
  const timeMs = opts.timeMs ?? Date.now();
  const step = opts.stepSec ?? 30;
  const window = opts.window ?? 1;
  const secret = base32Decode(secretBase32);
  const base = BigInt(Math.floor(timeMs / 1000 / step));
  for (let w = -window; w <= window; w += 1) {
    const expected = hotp(secret, base + BigInt(w), opts.digits ?? code.length);
    if (
      expected.length === code.length &&
      timingSafeEqual(Buffer.from(expected), Buffer.from(code))
    ) {
      return true;
    }
  }
  return false;
}

export function generateTotpSecret(): string {
  return base32Encode(randomBytes(20));
}

export function otpauthUri(
  issuer: string,
  account: string,
  secretBase32: string,
): string {
  const label = `${encodeURIComponent(issuer)}:${encodeURIComponent(account)}`;
  return `otpauth://totp/${label}?secret=${secretBase32}&issuer=${encodeURIComponent(issuer)}&algorithm=SHA1&digits=6&period=30`;
}
