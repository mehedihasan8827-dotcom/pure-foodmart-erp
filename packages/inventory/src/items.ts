import type { PoolClient } from "pg";
import { InventoryError, type ItemKind } from "./types";

export interface CreateItemInput {
  sku: string;
  name: string;
  kind: ItemKind;
  uom: "KG" | "PCS";
  /** Required for RAW/PACKAGING (e.g. '1310'/'1320'); forbidden for FINISHED. */
  inventoryAccountCode?: string;
  /** Required for RAW/PACKAGING (e.g. '5010'/'5020'); forbidden for FINISHED. */
  cogsAccountCode?: string;
}

export interface Item {
  id: number;
  sku: string;
  name: string;
  kind: ItemKind;
  uom: string;
}

export async function createItem(
  client: PoolClient,
  input: CreateItemInput,
): Promise<Item> {
  const isComponent = input.kind !== "FINISHED";
  if (isComponent && (!input.inventoryAccountCode || !input.cogsAccountCode)) {
    throw new InventoryError(
      `${input.kind} item ${input.sku} needs inventoryAccountCode and cogsAccountCode`,
    );
  }
  if (!isComponent && (input.inventoryAccountCode || input.cogsAccountCode)) {
    throw new InventoryError(
      `FINISHED item ${input.sku} must not carry component account mappings`,
    );
  }

  let invId: number | null = null;
  let cogsId: number | null = null;
  if (isComponent) {
    invId = await accountIdByCode(client, input.inventoryAccountCode!);
    cogsId = await accountIdByCode(client, input.cogsAccountCode!);
  }

  const res = await client.query<{ id: number }>(
    `INSERT INTO items (sku, name, kind, uom, inventory_account_id, cogs_account_id)
     VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
    [input.sku, input.name, input.kind, input.uom, invId, cogsId],
  );
  const id = res.rows[0]!.id;

  // Components get their stock-cache row immediately (blueprint §9.2).
  if (isComponent) {
    await client.query("INSERT INTO item_stock (item_id) VALUES ($1)", [id]);
  }
  return { id, sku: input.sku, name: input.name, kind: input.kind, uom: input.uom };
}

export async function getItemBySku(
  client: PoolClient,
  sku: string,
): Promise<Item | null> {
  const res = await client.query<Item>(
    "SELECT id, sku, name, kind, uom FROM items WHERE sku = $1",
    [sku],
  );
  return res.rows[0] ?? null;
}

async function accountIdByCode(
  client: PoolClient,
  code: string,
): Promise<number> {
  const res = await client.query<{ id: number }>(
    "SELECT id FROM accounts WHERE code = $1 AND is_active",
    [code],
  );
  const row = res.rows[0];
  if (!row) throw new InventoryError(`Unknown/inactive account code: ${code}`);
  return row.id;
}
