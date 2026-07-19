import type { PoolClient } from "pg";

export async function raiseAlert(
  c: PoolClient,
  code: string,
  details: unknown,
  severity: "WARN" | "ERROR" = "ERROR",
): Promise<void> {
  await c.query(
    "INSERT INTO integrity_alerts (invariant_code, severity, details) VALUES ($1,$2,$3)",
    [code, severity, JSON.stringify(details)],
  );
}

export async function setOrderState(
  c: PoolClient,
  orderId: number,
  state: string,
): Promise<void> {
  await c.query(
    "UPDATE sales_orders SET fin_state=$2, updated_at=now() WHERE id=$1",
    [orderId, state],
  );
}
