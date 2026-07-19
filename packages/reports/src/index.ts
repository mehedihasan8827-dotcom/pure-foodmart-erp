/**
 * @pfm/reports — read-only reporting aggregates (B9, S1/S4/S14).
 * Everything is derived from journal_lines at query time; tenant scoping
 * comes from withTransaction/RLS like every other module.
 */
export {
  getCashStrip,
  getDailySeries,
  getDashboard,
  getPlAggregate,
  type CashStrip,
  type DailyPl,
  type DashboardSummary,
  type PlAggregate,
} from "./dashboard";
export {
  getFundsBoard,
  getTrialBalanceReport,
  type FundsBoard,
  type TrialBalanceRow,
} from "./funds";
