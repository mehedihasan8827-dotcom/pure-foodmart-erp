/**
 * Money — exact BDT arithmetic on integer poisha (1 Taka = 100 poisha).
 *
 * Blueprint §11.3: money arithmetic never touches IEEE floats. All values
 * are bigint poisha internally; Taka strings only at the I/O boundary.
 * This is the ONLY money representation allowed across the codebase.
 */

const TAKA_PATTERN = /^(-?)(\d+)(?:\.(\d{1,2}))?$/;

export class Money {
  static readonly ZERO = new Money(0n);

  private constructor(readonly poisha: bigint) {}

  static fromPoisha(poisha: bigint): Money {
    return new Money(poisha);
  }

  /**
   * Parse a Taka amount from a string like "1150", "1150.5", "-23.75".
   * Numbers are accepted but stringified first; anything that does not
   * round-trip exactly (float noise, >2 decimals, exponent form) is rejected.
   */
  static fromTaka(input: string | number): Money {
    const text = typeof input === "number" ? String(input) : input.trim();
    const match = TAKA_PATTERN.exec(text);
    if (!match) {
      throw new RangeError(`Invalid Taka amount: "${text}"`);
    }
    const sign = match[1] ?? "";
    const whole = match[2] ?? "0";
    const fracPadded = (match[3] ?? "").padEnd(2, "0");
    const magnitude = BigInt(whole) * 100n + BigInt(fracPadded);
    return new Money(sign === "-" ? -magnitude : magnitude);
  }

  add(other: Money): Money {
    return new Money(this.poisha + other.poisha);
  }

  subtract(other: Money): Money {
    return new Money(this.poisha - other.poisha);
  }

  negate(): Money {
    return new Money(-this.poisha);
  }

  isZero(): boolean {
    return this.poisha === 0n;
  }

  isNegative(): boolean {
    return this.poisha < 0n;
  }

  equals(other: Money): boolean {
    return this.poisha === other.poisha;
  }

  compare(other: Money): -1 | 0 | 1 {
    if (this.poisha < other.poisha) return -1;
    if (this.poisha > other.poisha) return 1;
    return 0;
  }

  /** Plain decimal string, always 2 dp: "1150.00", "-23.75". */
  toTakaString(): string {
    const abs = this.poisha < 0n ? -this.poisha : this.poisha;
    const whole = abs / 100n;
    const frac = (abs % 100n).toString().padStart(2, "0");
    return `${this.poisha < 0n ? "-" : ""}${whole}.${frac}`;
  }

  /**
   * Display string with ৳ and digit grouping.
   * `grouping: "western"` → ৳1,234,567.89 · `"lakh"` → ৳12,34,567.89
   * Negative amounts render in parentheses per accounting convention.
   */
  format(grouping: "western" | "lakh" = "western"): string {
    const abs = this.poisha < 0n ? -this.poisha : this.poisha;
    const whole = (abs / 100n).toString();
    const frac = (abs % 100n).toString().padStart(2, "0");
    const grouped =
      grouping === "western" ? groupWestern(whole) : groupLakh(whole);
    const body = `৳${grouped}.${frac}`;
    return this.poisha < 0n ? `(${body})` : body;
  }
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
