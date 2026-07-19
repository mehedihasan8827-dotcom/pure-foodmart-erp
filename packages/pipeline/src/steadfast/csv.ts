import {
  canonicalPayoutInvoiceSchema,
  type CanonicalPayoutInvoice,
} from "@pfm/domain";

/**
 * CSV statement fallback (blueprint §6.3): parses a Steadfast payout
 * statement export into the SAME canonical invoice the API poller
 * produces — recordPayoutInvoice() cannot tell them apart.
 *
 * Column names are configurable because portal export headers shift;
 * defaults cover the common export. Charge columns are SUMMED per row
 * (delivery charge + COD charge on typical statements).
 */
export interface CsvColumnMap {
  consignmentId: string[];
  orderRef: string[];
  codCollected: string[];
  chargeColumns: string[];
}

const DEFAULT_COLUMNS: CsvColumnMap = {
  consignmentId: ["consignment id", "cid", "consignment"],
  orderRef: ["invoice", "order id", "order ref"],
  codCollected: ["cod amount", "collected amount", "cod"],
  chargeColumns: ["delivery charge", "cod charge", "charge"],
};

export class CsvParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CsvParseError";
  }
}

export function parseSteadfastStatementCsv(
  csvText: string,
  meta: {
    invoiceRef: string;
    statementDate: string; // YYYY-MM-DD
    payoutAccountCode?: "1020" | "1030";
  },
  columns: Partial<CsvColumnMap> = {},
): CanonicalPayoutInvoice {
  const map: CsvColumnMap = { ...DEFAULT_COLUMNS, ...columns };
  const rows = parseCsv(csvText);
  if (rows.length < 2) throw new CsvParseError("statement has no data rows");

  const header = rows[0]!.map((h) => h.toLowerCase().trim());
  const cidIdx = findColumn(header, map.consignmentId);
  const codIdx = findColumn(header, map.codCollected);
  if (cidIdx === -1 || codIdx === -1) {
    throw new CsvParseError(
      `required columns missing — found headers: ${header.join(", ")}`,
    );
  }
  const refIdx = findColumn(header, map.orderRef);
  const chargeIdxs = header
    .map((h, i) => (map.chargeColumns.some((c) => h === c) ? i : -1))
    .filter((i) => i !== -1);

  const lines = rows.slice(1).filter((r) => r.some((cell) => cell.trim() !== ""));
  const invoice = {
    invoiceRef: meta.invoiceRef,
    statementDate: meta.statementDate,
    payoutAccountCode: meta.payoutAccountCode ?? "1020",
    lines: lines.map((r, n) => {
      const cid = (r[cidIdx] ?? "").trim();
      if (!cid) throw new CsvParseError(`row ${n + 2}: empty consignment id`);
      const charge = chargeIdxs
        .map((i) => Number((r[i] ?? "0").replace(/,/g, "") || 0))
        .reduce((a, b) => a + b, 0);
      return {
        consignmentId: cid,
        orderRef: refIdx === -1 ? undefined : (r[refIdx] ?? "").trim() || undefined,
        codCollected: (r[codIdx] ?? "0").replace(/,/g, "").trim(),
        courierCharge: charge.toFixed(2),
      };
    }),
  };
  return canonicalPayoutInvoiceSchema.parse(invoice);
}

function findColumn(header: string[], names: string[]): number {
  for (const name of names) {
    const idx = header.indexOf(name);
    if (idx !== -1) return idx;
  }
  return -1;
}

/** Minimal RFC-4180-ish parser: quoted fields, escaped quotes, CRLF. */
function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i]!;
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 1;
        } else {
          inQuotes = false;
        }
      } else {
        field += ch;
      }
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === ",") {
      row.push(field);
      field = "";
    } else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && text[i + 1] === "\n") i += 1;
      row.push(field);
      field = "";
      rows.push(row);
      row = [];
    } else {
      field += ch;
    }
  }
  if (field !== "" || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}
