import { Money } from "@pfm/domain";
import { postEntry, withTransaction, type PostedEntry } from "@pfm/ledger";
import type { Pool } from "pg";
import {
  PortalError,
  assertDate,
  assertPaymentAccount,
  getAccount,
  writeAudit,
} from "./shared";

export interface RegisterAssetInput {
  assetCode: string;
  name: string;
  assetAccountCode: string; // 1510/1520/1530
  acquiredOn: string;
  cost: string;
  salvageValue?: string;
  method: "STRAIGHT_LINE" | "DIMINISHING";
  lifeMonths?: number; // STRAIGHT_LINE
  diminishingAnnualRate?: string; // DIMINISHING, e.g. "0.25"
  /** Cash location or '2010' (on credit). */
  paidFromAccountCode: string;
  enteredBy?: number | null;
}

export async function registerAsset(
  pool: Pool,
  tenantId: number,
  input: RegisterAssetInput,
): Promise<{ assetId: number; entry: PostedEntry }> {
  assertDate(input.acquiredOn, "acquiredOn");
  const cost = Money.fromTaka(input.cost);
  const salvage = Money.fromTaka(input.salvageValue ?? "0");
  if (cost.isZero() || cost.isNegative()) throw new PortalError("Cost must be positive");
  if (salvage.compare(cost) >= 0) throw new PortalError("Salvage must be below cost");
  if (input.method === "STRAIGHT_LINE" && !input.lifeMonths) {
    throw new PortalError("lifeMonths required for STRAIGHT_LINE");
  }
  if (input.method === "DIMINISHING" && !input.diminishingAnnualRate) {
    throw new PortalError("diminishingAnnualRate required for DIMINISHING");
  }
  return withTransaction(pool, tenantId, async (c) => {
    const assetAcct = await getAccount(c, input.assetAccountCode);
    if (assetAcct.type !== "ASSET" || assetAcct.isCashLocation) {
      throw new PortalError(`${input.assetAccountCode} is not a fixed-asset account`);
    }
    const paidFrom = await assertPaymentAccount(c, input.paidFromAccountCode, ["2010"]);

    const entry = await postEntry(c, {
      entryDate: input.acquiredOn,
      memo: `Fixed asset acquired: ${input.name}`,
      sourceType: "FIXED_ASSET",
      sourceId: null,
      eventCode: "FA_PURCHASE",
      postedBy: input.enteredBy ?? null,
      lines: [
        { accountCode: assetAcct.code, debit: cost },
        { accountCode: paidFrom.code, credit: cost },
      ],
    });
    const asset = await c.query<{ id: number }>(
      `INSERT INTO fixed_assets
         (asset_code, name, asset_account_id, acquired_on, cost, salvage_value,
          life_months, method, diminishing_annual_rate, purchase_entry_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING id`,
      [
        input.assetCode, input.name, assetAcct.id, input.acquiredOn,
        cost.toTakaString(), salvage.toTakaString(),
        input.lifeMonths ?? null, input.method,
        input.diminishingAnnualRate ?? null, entry.entryId,
      ],
    );
    const assetId = asset.rows[0]!.id;
    await writeAudit(c, input.enteredBy ?? null, "ASSET_REGISTERED", "fixed_assets", assetId, {
      assetCode: input.assetCode, cost: cost.toTakaString(),
    });
    return { assetId, entry };
  });
}

export interface DepreciationRunResult {
  period: string;
  totalCharge: Money;
  entry: PostedEntry | null; // null when nothing to charge
  perAsset: { assetCode: string; charge: string; bookValueAfter: string }[];
  skipped: string[]; // already charged / fully depreciated
}

/**
 * Monthly depreciation (blueprint §8): one aggregate JE (Dr 6210 /
 * Cr 1590) with per-asset breakdown rows. Idempotent by design — the
 * UNIQUE(asset_id, period) constraint plus the pre-check make re-runs
 * no-ops asset by asset. First month is prorated by acquisition day;
 * charges stop exactly at salvage value.
 */
export async function runDepreciation(
  pool: Pool,
  tenantId: number,
  period: string, // 'YYYY-MM'
): Promise<DepreciationRunResult> {
  if (!/^\d{4}-\d{2}$/.test(period)) throw new PortalError("period must be YYYY-MM");
  return withTransaction(pool, tenantId, async (c) => {
    const p = await c.query<{ ends_on: string; is_locked: boolean }>(
      "SELECT ends_on::text, is_locked FROM fiscal_periods WHERE period=$1",
      [period],
    );
    if (!p.rows[0]) throw new PortalError(`Unknown fiscal period ${period}`);
    if (p.rows[0].is_locked) throw new PortalError(`Period ${period} is locked`);
    const periodEnd = p.rows[0].ends_on;

    const assets = await c.query<{
      id: number;
      asset_code: string;
      acquired_on: string;
      cost: string;
      salvage_value: string;
      life_months: number | null;
      method: string;
      diminishing_annual_rate: string | null;
      accum: string;
      already: boolean;
    }>(
      `SELECT a.id, a.asset_code, a.acquired_on::text, a.cost::text,
              a.salvage_value::text, a.life_months, a.method,
              a.diminishing_annual_rate::text,
              COALESCE((SELECT SUM(d.amount) FROM depreciation_entries d
                        WHERE d.asset_id = a.id), 0)::NUMERIC(14,2)::text AS accum,
              EXISTS(SELECT 1 FROM depreciation_entries d
                     WHERE d.asset_id = a.id AND d.period = $1) AS already
       FROM fixed_assets a
       WHERE a.status = 'ACTIVE' AND a.acquired_on <= $2::date
       ORDER BY a.id FOR UPDATE OF a`,
      [period, periodEnd],
    );

    const charges: { assetId: number; assetCode: string; charge: Money; bookAfter: Money }[] = [];
    const skipped: string[] = [];
    for (const a of assets.rows) {
      if (a.already) {
        skipped.push(`${a.asset_code} (already charged for ${period})`);
        continue;
      }
      const cost = Money.fromTaka(a.cost);
      const salvage = Money.fromTaka(a.salvage_value);
      const book = cost.subtract(Money.fromTaka(a.accum));
      const depreciable = book.subtract(salvage);
      if (depreciable.isZero() || depreciable.isNegative()) {
        skipped.push(`${a.asset_code} (fully depreciated)`);
        continue;
      }
      let monthly: Money;
      if (a.method === "STRAIGHT_LINE") {
        monthly = divRound(cost.subtract(salvage), BigInt(a.life_months!));
      } else {
        // book value × annual rate / 12, at poisha precision
        const rateMilli = BigInt(Math.round(Number(a.diminishing_annual_rate) * 1_000_000));
        monthly = Money.fromPoisha(
          divBig(book.poisha * rateMilli, 12n * 1_000_000n),
        );
      }
      // First-month proration by acquisition day (blueprint §8).
      if (a.acquired_on.slice(0, 7) === period) {
        const day = Number(a.acquired_on.slice(8, 10));
        const daysInMonth = Number(periodEnd.slice(8, 10));
        monthly = Money.fromPoisha(
          divBig(monthly.poisha * BigInt(daysInMonth - day + 1), BigInt(daysInMonth)),
        );
      }
      const charge = monthly.compare(depreciable) > 0 ? depreciable : monthly;
      if (charge.isZero()) {
        skipped.push(`${a.asset_code} (zero charge)`);
        continue;
      }
      charges.push({
        assetId: a.id,
        assetCode: a.asset_code,
        charge,
        bookAfter: book.subtract(charge),
      });
    }

    if (charges.length === 0) {
      return { period, totalCharge: Money.ZERO, entry: null, perAsset: [], skipped };
    }
    const total = charges.reduce((acc, x) => acc.add(x.charge), Money.ZERO);
    const entry = await postEntry(c, {
      entryDate: periodEnd,
      memo: `Depreciation ${period} (${charges.length} asset${charges.length > 1 ? "s" : ""})`,
      sourceType: "DEPRECIATION",
      sourceId: null,
      eventCode: "FA_DEPRECIATION",
      lines: [
        { accountCode: "6210", debit: total },
        { accountCode: "1590", credit: total },
      ],
    });
    for (const x of charges) {
      await c.query(
        `INSERT INTO depreciation_entries
           (asset_id, period, amount, book_value_after, posted_entry_id)
         VALUES ($1,$2,$3,$4,$5)`,
        [x.assetId, period, x.charge.toTakaString(), x.bookAfter.toTakaString(), entry.entryId],
      );
    }
    return {
      period,
      totalCharge: total,
      entry,
      perAsset: charges.map((x) => ({
        assetCode: x.assetCode,
        charge: x.charge.toTakaString(),
        bookValueAfter: x.bookAfter.toTakaString(),
      })),
      skipped,
    };
  });
}

export interface DisposeAssetInput {
  assetCode: string;
  disposedOn: string;
  salePrice: string; // 0 = write-off
  /** Where the proceeds land (cash location). */
  proceedsAccountCode: string;
  enteredBy?: number | null;
}

export interface DisposeAssetResult {
  disposalId: number;
  entry: PostedEntry;
  bookValue: Money;
  gainLoss: Money; // + gain / − loss
}

/**
 * §4.6 disposal with automatic gain/loss. Tip: run depreciation for the
 * disposal month first if you want the final partial-month charge
 * reflected in book value — this function uses accumulated depreciation
 * as posted.
 */
export async function disposeAsset(
  pool: Pool,
  tenantId: number,
  input: DisposeAssetInput,
): Promise<DisposeAssetResult> {
  assertDate(input.disposedOn, "disposedOn");
  const sale = Money.fromTaka(input.salePrice);
  if (sale.isNegative()) throw new PortalError("Sale price cannot be negative");
  return withTransaction(pool, tenantId, async (c) => {
    const res = await c.query<{
      id: number;
      name: string;
      status: string;
      cost: string;
      accum: string;
      asset_account_code: string;
    }>(
      `SELECT a.id, a.name, a.status, a.cost::text, acc.code AS asset_account_code,
              COALESCE((SELECT SUM(d.amount) FROM depreciation_entries d
                        WHERE d.asset_id = a.id), 0)::NUMERIC(14,2)::text AS accum
       FROM fixed_assets a JOIN accounts acc ON acc.id = a.asset_account_id
       WHERE a.asset_code = $1 FOR UPDATE OF a`,
      [input.assetCode],
    );
    const asset = res.rows[0];
    if (!asset) throw new PortalError(`Unknown asset ${input.assetCode}`);
    if (asset.status !== "ACTIVE") {
      throw new PortalError(`Asset ${input.assetCode} is ${asset.status}`);
    }
    const proceeds = await assertPaymentAccount(c, input.proceedsAccountCode);
    const cost = Money.fromTaka(asset.cost);
    const accum = Money.fromTaka(asset.accum);
    const bookValue = cost.subtract(accum);
    const gainLoss = sale.subtract(bookValue);

    const lines = [
      ...(sale.isZero() ? [] : [{ accountCode: proceeds.code, debit: sale }]),
      ...(accum.isZero() ? [] : [{ accountCode: "1590", debit: accum }]),
      ...(gainLoss.isNegative()
        ? [{ accountCode: "6910", debit: gainLoss.negate() }]
        : []),
      { accountCode: asset.asset_account_code, credit: cost },
      ...(!gainLoss.isNegative() && !gainLoss.isZero()
        ? [{ accountCode: "4910", credit: gainLoss }]
        : []),
    ];
    const entry = await postEntry(c, {
      entryDate: input.disposedOn,
      memo: `Asset disposal: ${asset.name} (book ${bookValue.toTakaString()}, sold ${sale.toTakaString()})`,
      sourceType: "FIXED_ASSET",
      sourceId: asset.id,
      eventCode: "FA_DISPOSAL",
      postedBy: input.enteredBy ?? null,
      lines,
    });
    const disposal = await c.query<{ id: string }>(
      `INSERT INTO asset_disposals
         (asset_id, disposed_on, sale_price, proceeds_account_id, book_value,
          gain_loss, posted_entry_id, entered_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id`,
      [
        asset.id, input.disposedOn, sale.toTakaString(), proceeds.id,
        bookValue.toTakaString(), gainLoss.toTakaString(),
        entry.entryId, input.enteredBy ?? null,
      ],
    );
    await c.query("UPDATE fixed_assets SET status='DISPOSED' WHERE id=$1", [asset.id]);
    await writeAudit(c, input.enteredBy ?? null, "ASSET_DISPOSED", "fixed_assets", asset.id, {
      salePrice: sale.toTakaString(), gainLoss: gainLoss.toTakaString(),
    });
    return { disposalId: Number(disposal.rows[0]!.id), entry, bookValue, gainLoss };
  });
}

/** Integer division of poisha with round-half-up, sign-safe for our use (positive amounts). */
function divRound(amount: Money, divisor: bigint): Money {
  return Money.fromPoisha(divBig(amount.poisha, divisor));
}
function divBig(numerator: bigint, divisor: bigint): bigint {
  return (numerator + divisor / 2n) / divisor;
}
