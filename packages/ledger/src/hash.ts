import { createHash } from "node:crypto";

export const GENESIS_HASH = "0".repeat(64);

export interface HashableLine {
  lineNo: number;
  accountId: number;
  /** Normalized 2-dp decimal strings, e.g. "1150.00" / "0.00". */
  debit: string;
  credit: string;
}

/**
 * Tamper-evidence chain (blueprint §10.3):
 *   entry_hash = SHA256(prev_hash ‖ entry_no ‖ entry_date ‖ canonical(lines))
 *
 * Canonical form is deliberately primitive — pipe/semicolon-joined strings,
 * not JSON — so it cannot drift with serializer versions.
 */
export function computeEntryHash(
  prevHash: string,
  entryNo: number,
  entryDate: string,
  lines: readonly HashableLine[],
): string {
  const canonicalLines = [...lines]
    .sort((a, b) => a.lineNo - b.lineNo)
    .map((l) => `${l.lineNo}|${l.accountId}|${l.debit}|${l.credit}`)
    .join(";");
  return createHash("sha256")
    .update(`${prevHash}\n${entryNo}\n${entryDate}\n${canonicalLines}`)
    .digest("hex");
}
