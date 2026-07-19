/**
 * @pfm/steadfast-client — typed Steadfast Courier API client: statuses,
 * merchant balance, payout invoices (capability-gated), retry/backoff.
 */
export {
  SteadfastApiError,
  SteadfastCapabilityError,
  SteadfastClient,
  mapDeliveryStatus,
  type SteadfastClientConfig,
} from "./client";
