import type { Grouping } from "./prefs";

/**
 * DISPLAY-ONLY formatting. The frontend never computes balances —
 * amounts arrive as exact decimal strings from the backend (§17.1).
 */
export function formatTaka(amount: string, grouping: Grouping): string {
  const negative = amount.startsWith("-");
  const abs = negative ? amount.slice(1) : amount;
  const [whole = "0", frac = "00"] = abs.split(".");
  const grouped =
    grouping === "lakh" ? groupLakh(whole) : groupWestern(whole);
  const body = `৳${grouped}.${frac.padEnd(2, "0").slice(0, 2)}`;
  return negative ? `(${body})` : body;
}

function groupWestern(digits: string): string {
  return digits.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

function groupLakh(digits: string): string {
  if (digits.length <= 3) return digits;
  const last3 = digits.slice(-3);
  const rest = digits.slice(0, -3).replace(/\B(?=(\d{2})+(?!\d))/g, ",");
  return `${rest},${last3}`;
}
