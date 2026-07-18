import { describe, expect, it } from "vitest";
import { Money } from "./money";

describe("Money", () => {
  it("parses whole and fractional Taka exactly", () => {
    expect(Money.fromTaka("1150").poisha).toBe(115000n);
    expect(Money.fromTaka("1150.5").poisha).toBe(115050n);
    expect(Money.fromTaka("1150.05").poisha).toBe(115005n);
    expect(Money.fromTaka("-23.75").poisha).toBe(-2375n);
    expect(Money.fromTaka(612).poisha).toBe(61200n);
  });

  it("rejects malformed amounts", () => {
    for (const bad of ["", "1.234", "1,150", "abc", "1e3", "1.2.3", "৳100"]) {
      expect(() => Money.fromTaka(bad), bad).toThrow(RangeError);
    }
  });

  it("adds and subtracts without drift", () => {
    const a = Money.fromTaka("0.10");
    const b = Money.fromTaka("0.20");
    // the classic 0.1 + 0.2 float trap must not exist here
    expect(a.add(b).equals(Money.fromTaka("0.30"))).toBe(true);
    expect(Money.fromTaka("46000").subtract(Money.fromTaka("3120")).toTakaString()).toBe(
      "42880.00",
    );
  });

  it("renders plain and formatted strings", () => {
    expect(Money.fromTaka("1150").toTakaString()).toBe("1150.00");
    expect(Money.fromTaka("1234567.89").format("western")).toBe("৳1,234,567.89");
    expect(Money.fromTaka("1234567.89").format("lakh")).toBe("৳12,34,567.89");
    expect(Money.fromTaka("-42").format()).toBe("(৳42.00)");
  });

  it("compares correctly", () => {
    expect(Money.fromTaka("1").compare(Money.fromTaka("2"))).toBe(-1);
    expect(Money.ZERO.isZero()).toBe(true);
    expect(Money.fromTaka("-5").isNegative()).toBe(true);
  });
});
