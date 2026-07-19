import { createHash } from "node:crypto";

/** Key-sorted (recursive) JSON, so semantically-equal payloads hash equal. */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}

export function sha256Canonical(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value as Record<string, unknown>)
        .sort()
        .map((k) => [k, sortKeys((value as Record<string, unknown>)[k])]),
    );
  }
  return value;
}
