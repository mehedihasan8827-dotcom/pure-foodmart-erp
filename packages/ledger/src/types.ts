import type { Money } from "@pfm/domain";

/** Mirrors the source_type enum in db/migrations/001_enums.sql. */
export type SourceType =
  | "NUPORT_ORDER"
  | "SETTLEMENT"
  | "PURCHASE"
  | "EXPENSE"
  | "EQUITY"
  | "FIXED_ASSET"
  | "DEPRECIATION"
  | "STOCK_COUNT"
  | "MANUAL_JOURNAL"
  | "CLOSING";

/** One line of a journal entry. Exactly one of debit/credit, and it must be positive. */
export interface JournalLineInput {
  accountCode: string;
  debit?: Money;
  credit?: Money;
  description?: string;
}

export interface PostEntryInput {
  /** ISO date 'YYYY-MM-DD'; the fiscal period is derived from it. */
  entryDate: string;
  memo: string;
  sourceType: SourceType;
  sourceId?: number | null;
  /** Posting-rule matrix code, blueprint §4.7 (e.g. 'SALE_DELIVERED_COD'). */
  eventCode: string;
  lines: JournalLineInput[];
  postedBy?: number | null;
  reversalOf?: number | null;
}

export interface PostedEntry {
  entryId: number;
  entryNo: number;
  period: string;
  entryHash: string;
}

export class LedgerError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LedgerError";
  }
}
