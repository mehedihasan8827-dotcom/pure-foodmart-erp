import type { PoolClient } from "pg";

export class PortalError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PortalError";
  }
}

export interface AccountInfo {
  id: number;
  code: string;
  type: string;
  isCashLocation: boolean;
}

export async function getAccount(
  c: PoolClient,
  code: string,
): Promise<AccountInfo> {
  const res = await c.query<{
    id: number;
    code: string;
    type: string;
    is_cash_location: boolean;
  }>(
    "SELECT id, code, type, is_cash_location FROM accounts WHERE code = $1 AND is_active",
    [code],
  );
  const row = res.rows[0];
  if (!row) throw new PortalError(`Unknown/inactive account code: ${code}`);
  return {
    id: row.id,
    code: row.code,
    type: row.type,
    isCashLocation: row.is_cash_location,
  };
}

/** Money can only leave/enter through a cash location (or the allowed liability codes). */
export async function assertPaymentAccount(
  c: PoolClient,
  code: string,
  extraAllowedCodes: string[] = [],
): Promise<AccountInfo> {
  const acct = await getAccount(c, code);
  if (!acct.isCashLocation && !extraAllowedCodes.includes(code)) {
    throw new PortalError(
      `Account ${code} is not a cash location${extraAllowedCodes.length ? ` (or one of: ${extraAllowedCodes.join(", ")})` : ""}`,
    );
  }
  return acct;
}

export async function writeAudit(
  c: PoolClient,
  userId: number | null,
  action: string,
  entity: string,
  entityId: number | null,
  after: unknown,
): Promise<void> {
  await c.query(
    `INSERT INTO audit_log (tenant_id, user_id, action, entity, entity_id, after_json)
     VALUES (app_tenant_id(), $1, $2, $3, $4, $5)`,
    [userId, action, entity, entityId, after === undefined ? null : JSON.stringify(after)],
  );
}

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
export function assertDate(value: string, label: string): void {
  if (!DATE_PATTERN.test(value)) {
    throw new PortalError(`${label} must be YYYY-MM-DD, got "${value}"`);
  }
}
