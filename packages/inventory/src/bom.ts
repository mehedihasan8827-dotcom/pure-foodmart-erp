import type { PoolClient } from "pg";
import { InventoryError, assertQty, type QtyString } from "./types";

export interface BomComponentInput {
  sku: string;
  qtyPerUnit: QtyString;
}

export interface CreateBomInput {
  finishedSku: string;
  validFrom: string; // YYYY-MM-DD
  components: BomComponentInput[];
}

export interface BomVersion {
  bomId: number;
  finishedItemId: number;
  version: number;
}

/**
 * Create a new BOM version (blueprint §5.2). The currently-open version, if
 * any, is closed the day before validFrom — historical COGS keeps pointing
 * at the version active at its delivery date, so past P&L never changes.
 */
export async function createBom(
  client: PoolClient,
  input: CreateBomInput,
): Promise<BomVersion> {
  if (input.components.length === 0) {
    throw new InventoryError(`BOM for ${input.finishedSku} has no components`);
  }
  const fin = await client.query<{ id: number; kind: string }>(
    "SELECT id, kind FROM items WHERE sku = $1",
    [input.finishedSku],
  );
  const finished = fin.rows[0];
  if (!finished) throw new InventoryError(`Unknown SKU: ${input.finishedSku}`);
  if (finished.kind !== "FINISHED") {
    throw new InventoryError(`${input.finishedSku} is not a FINISHED item`);
  }

  await client.query(
    `UPDATE boms SET valid_to = ($2::date - 1)
     WHERE finished_item_id = $1 AND valid_to IS NULL`,
    [finished.id, input.validFrom],
  );

  const ver = await client.query<{ next: number }>(
    "SELECT COALESCE(MAX(version), 0) + 1 AS next FROM boms WHERE finished_item_id = $1",
    [finished.id],
  );
  const version = ver.rows[0]!.next;

  const bom = await client.query<{ id: number }>(
    `INSERT INTO boms (finished_item_id, version, valid_from)
     VALUES ($1,$2,$3) RETURNING id`,
    [finished.id, version, input.validFrom],
  );
  const bomId = bom.rows[0]!.id;

  for (const c of input.components) {
    assertQty(c.qtyPerUnit, `qtyPerUnit(${c.sku})`);
    const comp = await client.query<{ id: number; kind: string }>(
      "SELECT id, kind FROM items WHERE sku = $1",
      [c.sku],
    );
    const compRow = comp.rows[0];
    if (!compRow) throw new InventoryError(`Unknown component SKU: ${c.sku}`);
    if (compRow.kind === "FINISHED") {
      throw new InventoryError(
        `Component ${c.sku} is FINISHED — nested BOMs are not supported`,
      );
    }
    await client.query(
      `INSERT INTO bom_lines (bom_id, component_item_id, qty_per_unit)
       VALUES ($1,$2,$3::numeric(12,3))`,
      [bomId, compRow.id, c.qtyPerUnit],
    );
  }
  return { bomId, finishedItemId: finished.id, version };
}

/** Active BOM id for a finished item on a given date, or null. */
export async function getActiveBomId(
  client: PoolClient,
  finishedItemId: number,
  onDate: string,
): Promise<number | null> {
  const res = await client.query<{ id: number }>(
    `SELECT id FROM boms
     WHERE finished_item_id = $1
       AND valid_from <= $2::date
       AND (valid_to IS NULL OR valid_to >= $2::date)
     ORDER BY version DESC LIMIT 1`,
    [finishedItemId, onDate],
  );
  return res.rows[0]?.id ?? null;
}

export interface ComponentRequirement {
  itemId: number;
  sku: string;
  reqQty: string; // NUMERIC(12,3) as text, merged across all order lines
  inventoryAccountCode: string;
  cogsAccountCode: string;
}

/**
 * Explode + merge (blueprint §5.4 step 2): multiply each order line's qty
 * through its BOM, then merge duplicate components across lines — a combo
 * and a single pack both consuming raw jaggery yield ONE requirement row.
 * All multiplication happens in PostgreSQL NUMERIC. Ordered by item id
 * (deadlock-avoidance lock order, §5.4 step 3).
 */
export async function explodeAndMerge(
  client: PoolClient,
  lines: { bomId: number; qty: QtyString }[],
): Promise<ComponentRequirement[]> {
  if (lines.length === 0) return [];
  for (const l of lines) assertQty(l.qty);
  const values: string[] = [];
  const params: unknown[] = [];
  lines.forEach((l, i) => {
    values.push(`($${i * 2 + 1}::int, $${i * 2 + 2}::numeric(12,3))`);
    params.push(l.bomId, l.qty);
  });
  const res = await client.query<{
    item_id: number;
    sku: string;
    req_qty: string;
    inv_code: string;
    cogs_code: string;
  }>(
    `SELECT bl.component_item_id            AS item_id,
            i.sku                           AS sku,
            SUM(bl.qty_per_unit * v.qty)::numeric(12,3)::text AS req_qty,
            inv.code                        AS inv_code,
            cog.code                        AS cogs_code
     FROM (VALUES ${values.join(",")}) AS v(bom_id, qty)
     JOIN bom_lines bl ON bl.bom_id = v.bom_id
     JOIN items i      ON i.id = bl.component_item_id
     JOIN accounts inv ON inv.id = i.inventory_account_id
     JOIN accounts cog ON cog.id = i.cogs_account_id
     GROUP BY bl.component_item_id, i.sku, inv.code, cog.code
     ORDER BY bl.component_item_id`,
    params,
  );
  return res.rows.map((r) => ({
    itemId: r.item_id,
    sku: r.sku,
    reqQty: r.req_qty,
    inventoryAccountCode: r.inv_code,
    cogsAccountCode: r.cogs_code,
  }));
}
