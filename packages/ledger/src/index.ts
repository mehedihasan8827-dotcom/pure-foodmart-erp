/**
 * @pfm/ledger — the ONLY module allowed to write journal entries.
 * Blueprint §4 (posting rules), §10 (integrity), §11.2 (module boundary).
 */
export { GENESIS_HASH, computeEntryHash } from "./hash";
export { postEntry, withTransaction } from "./post";
export {
  LedgerError,
  type JournalLineInput,
  type PostEntryInput,
  type PostedEntry,
  type SourceType,
} from "./types";
export {
  accountBalance,
  trialBalance,
  verifyHashChain,
  type ChainVerification,
  type TrialBalance,
} from "./verify";
