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

export interface RecordExpenseInput {
  expenseDate: string; // YYYY-MM-DD
  /** A 6xxx (or 5090) expense account. */
  expenseAccountCode: string;
  /** Cash location (1010/1020/1030/1040) or '2210' for an accrual. */
  paidFromAccountCode: string;
  amount: string; // Taka, 2 dp
  description: string;
  receiptUrl?: string | null;
  enteredBy?: number | null;
}

export interface RecordExpenseResult {
  expenseId: number;
  entry: PostedEntry;
}

/**
 * Daily operational expense entry (blueprint §4.4): Dr expense / Cr cash
 * (or Cr 2210 Accrued Expenses for month-end accruals). The mobile app's
 * ≤3-tap flow (§17.5) lands here; receiptUrl points at object storage
 * (signed-upload wiring in B13).
 */
export async function recordExpense(
  pool: Pool,
  tenantId: number,
  input: RecordExpenseInput,
): Promise<RecordExpenseResult> {
  assertDate(input.expenseDate, "expenseDate");
  const amount = Money.fromTaka(input.amount);
  if (amount.isNegative() || amount.isZero()) {
    throw new PortalError("Expense amount must be positive");
  }
  if (!input.description.trim()) {
    throw new PortalError("Description is required");
  }
  return withTransaction(pool, tenantId, async (c) => {
    const expenseAcct = await getAccount(c, input.expenseAccountCode);
    if (expenseAcct.type !== "EXPENSE") {
      throw new PortalError(
        `${input.expenseAccountCode} is ${expenseAcct.type}, not an EXPENSE account`,
      );
    }
    const paidFrom = await assertPaymentAccount(c, input.paidFromAccountCode, ["2210"]);

    const row = await c.query<{ id: string }>(
      `INSERT INTO expenses
         (expense_date, expense_account_id, paid_from_account_id, amount,
          description, receipt_url, entered_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
      [
        input.expenseDate,
        expenseAcct.id,
        paidFrom.id,
        amount.toTakaString(),
        input.description.trim(),
        input.receiptUrl ?? null,
        input.enteredBy ?? null,
      ],
    );
    const expenseId = Number(row.rows[0]!.id);

    const entry = await postEntry(c, {
      entryDate: input.expenseDate,
      memo: `Expense: ${input.description.trim()}`,
      sourceType: "EXPENSE",
      sourceId: expenseId,
      eventCode: "OPEX",
      postedBy: input.enteredBy ?? null,
      lines: [
        { accountCode: expenseAcct.code, debit: amount },
        { accountCode: paidFrom.code, credit: amount },
      ],
    });
    await c.query("UPDATE expenses SET posted_entry_id=$2 WHERE id=$1", [
      expenseId,
      entry.entryId,
    ]);
    await writeAudit(c, input.enteredBy ?? null, "EXPENSE_RECORDED", "expenses", expenseId, {
      amount: amount.toTakaString(),
      expenseAccount: expenseAcct.code,
      paidFrom: paidFrom.code,
    });
    return { expenseId, entry };
  });
}
