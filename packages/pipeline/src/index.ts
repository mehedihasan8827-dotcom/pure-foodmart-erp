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
