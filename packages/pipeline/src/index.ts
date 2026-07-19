/**
 * @pfm/pipeline — event ingestion + financial state machines that turn
 * operational events (Nuport orders in B4, Steadfast payouts in B5) into
 * ledger postings. Shared by the API webhook receiver and the worker.
 */
export { canonicalJson, sha256Canonical } from "./hash";
export {
  ingestNuportEvent,
  type IngestInput,
  type IngestResult,
} from "./nuport/ingest";
export {
  backfillCogs,
  processNuportEvent,
  type ProcessOutcome,
  type ProcessResult,
} from "./nuport/process";
export {
  runNuportSync,
  type NuportOrderSource,
  type SyncSummary,
} from "./nuport/sync";
export {
  CredentialsError,
  openCredentials,
  sealCredentials,
} from "./credentials";
export { postDeliveryFromDb, type DeliveryPostResult } from "./shared/delivery";
export {
  ingestSteadfastEvent,
  markSteadfastEvent,
  type SteadfastEventKind,
  type SteadfastIngestInput,
  type SteadfastIngestResult,
} from "./steadfast/ingest";
export {
  processSteadfastStatus,
  type StatusOutcome,
  type StatusResult,
} from "./steadfast/status";
export {
  checkCourierFunds,
  confirmPayoutDisbursed,
  recordPayoutInvoice,
  type ConfirmDisbursementInput,
  type ConfirmDisbursementResult,
  type RecordInvoiceResult,
} from "./steadfast/settlement";
export {
  CsvParseError,
  parseSteadfastStatementCsv,
  type CsvColumnMap,
} from "./steadfast/csv";
export {
  checkSteadfastBalanceDrift,
  type BalanceDriftReport,
} from "./steadfast/balance";
export {
  runSteadfastPoll,
  type SteadfastPollSource,
  type SteadfastPollSummary,
} from "./steadfast/poll";
