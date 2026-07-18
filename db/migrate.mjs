#!/usr/bin/env node
/**
 * Forward-only migration runner.
 *
 * Commands:
 *   node migrate.mjs up      — apply pending migrations (each in its own transaction)
 *   node migrate.mjs seed    — apply seed.sql (idempotent)
 *   node migrate.mjs status  — show applied vs pending
 *
 * Applied migrations are checksummed; editing an already-applied file is an
 * error — add a new migration instead (mirrors the ledger's append-only rule).
 */
import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";

const DEFAULT_URL =
  "postgres://erp:erp_local_dev@localhost:5432/pure_foodmart_erp";
const here = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = join(here, "migrations");

function sha256(text) {
  return createHash("sha256").update(text).digest("hex");
}

async function listMigrationFiles() {
  const entries = await readdir(MIGRATIONS_DIR);
  return entries.filter((f) => f.endsWith(".sql")).sort();
}

async function ensureMigrationsTable(client) {
  await client.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      name       TEXT PRIMARY KEY,
      checksum   CHAR(64) NOT NULL,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )`);
}

async function appliedMap(client) {
  const { rows } = await client.query(
    "SELECT name, checksum FROM schema_migrations",
  );
  return new Map(rows.map((r) => [r.name, r.checksum]));
}

async function up(client) {
  await ensureMigrationsTable(client);
  const applied = await appliedMap(client);
  const files = await listMigrationFiles();
  let ran = 0;
  for (const file of files) {
    const sql = await readFile(join(MIGRATIONS_DIR, file), "utf8");
    const checksum = sha256(sql);
    const prior = applied.get(file);
    if (prior) {
      if (prior !== checksum) {
        throw new Error(
          `Migration ${file} was modified after being applied. ` +
            "Migrations are append-only: add a new migration instead.",
        );
      }
      continue;
    }
    process.stdout.write(`applying ${file} ... `);
    await client.query("BEGIN");
    try {
      await client.query(sql);
      await client.query(
        "INSERT INTO schema_migrations (name, checksum) VALUES ($1, $2)",
        [file, checksum],
      );
      await client.query("COMMIT");
    } catch (err) {
      await client.query("ROLLBACK");
      console.log("FAILED");
      throw err;
    }
    console.log("ok");
    ran += 1;
  }
  console.log(ran === 0 ? "nothing to apply — up to date" : `applied ${ran} migration(s)`);
}

async function seed(client) {
  const sql = await readFile(join(here, "seed.sql"), "utf8");
  await client.query("BEGIN");
  try {
    await client.query(sql);
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  }
  console.log("seed applied (idempotent)");
}

async function status(client) {
  await ensureMigrationsTable(client);
  const applied = await appliedMap(client);
  for (const file of await listMigrationFiles()) {
    console.log(`${applied.has(file) ? "applied" : "PENDING"}  ${file}`);
  }
}

async function main() {
  const cmd = process.argv[2] ?? "up";
  const client = new pg.Client({
    connectionString: process.env.DATABASE_URL ?? DEFAULT_URL,
  });
  await client.connect();
  try {
    if (cmd === "up") await up(client);
    else if (cmd === "seed") await seed(client);
    else if (cmd === "status") await status(client);
    else throw new Error(`Unknown command: ${cmd} (use up | seed | status)`);
  } finally {
    await client.end();
  }
}

main().catch((err) => {
  console.error(err.message ?? err);
  process.exit(1);
});
