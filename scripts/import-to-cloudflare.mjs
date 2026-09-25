#!/usr/bin/env node
// Imports an export produced by scripts/export-from-live.mjs into a D1 database and R2 bucket with wrangler.
//
//   node scripts/import-to-cloudflare.mjs --in ./migration-export --database clientrecord-crm-db \
//     --bucket clientrecord-crm-files (--local|--remote) [--dry-run] [--force] [--config <wrangler.json>] [--persist-to <dir>]
//
// Apply the drizzle migrations to the target first; this script only checks that every exported table exists there.
import fs from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { parseArgs } from "node:util";
import { fileURLToPath } from "node:url";
import { safeObjectPath, sha256File } from "./export-from-live.mjs";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const D1_STATEMENT_LIMIT = 100_000;
const quote = name => `"${String(name).replaceAll('"', '""')}"`;

/** Renders a JSON value as a SQLite literal. Arrays / byte arrays are BLOBs (X'..'); text containing NUL is hex-cast so nothing truncates it. */
export function sqlLiteral(value) {
  if (value === null || value === undefined) return "NULL";
  if (typeof value === "boolean") return value ? "1" : "0";
  if (typeof value === "bigint") return value.toString();
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError(`Cannot import non-finite number ${value}`);
    return Object.is(value, -0) ? "0" : String(value);
  }
  if (typeof value === "string") return value.includes("\0") ? `CAST(X'${Buffer.from(value, "utf8").toString("hex").toUpperCase()}' AS TEXT)` : `'${value.replaceAll("'", "''")}'`;
  if (Array.isArray(value) || value instanceof Uint8Array) {
    const bytes = Array.from(value);
    if (bytes.some(byte => !Number.isInteger(byte) || byte < 0 || byte > 255)) throw new TypeError("Binary values must be arrays of bytes (0-255).");
    return `X'${Buffer.from(bytes).toString("hex").toUpperCase()}'`;
  }
  throw new TypeError(`Unsupported value for SQL import: ${Object.prototype.toString.call(value)}`);
}

const lookup = (source, key) => (source instanceof Map ? source.get(key) : Object.hasOwn(source || {}, key) ? source[key] : undefined);

/** Orders tables parents-first using table → parent-table dependencies. Self references and unknown parents are ignored; cycles keep input order. */
export function topoSort(tables, dependencies) {
  const pending = new Set(tables), order = [];
  while (pending.size) {
    const ready = [...pending].find(table => (lookup(dependencies, table) || []).every(parent => parent === table || !pending.has(parent)));
    const next = ready ?? pending.values().next().value;
    order.push(next);
    pending.delete(next);
  }
  return order;
}

/**
 * Builds chunked INSERT files. exports: [{table, columns, rows}], targetColumns: table → column names in the target,
 * order: import order. Returns {files:[{name, table, rows, sql}], warnings, plan}.
 */
export function buildImportSql({ exports, targetColumns, order, maxRows = 500, maxBytes = 5_000_000 }) {
  const byTable = new Map(exports.map(item => [item.table, item]));
  const files = [], warnings = [], plan = [];
  for (const table of order) {
    const data = byTable.get(table);
    if (!data) continue;
    const target = lookup(targetColumns, table);
    if (!target) throw new Error(`Table ${table} does not exist in the target database. Apply the migrations first.`);
    const columns = data.columns.filter(column => target.includes(column)), dropped = data.columns.filter(column => !target.includes(column));
    if (dropped.length) warnings.push(`${table}: target has no column(s) ${dropped.join(", ")}; those values are not imported.`);
    const prefix = `INSERT INTO ${quote(table)} (${columns.map(quote).join(",")}) VALUES (`, header = "PRAGMA defer_foreign_keys = on;\n";
    let statements = [], bytes = 0, part = 0;
    const flush = () => {
      if (!statements.length) return;
      part++;
      files.push({ name: `${String(files.length + 1).padStart(4, "0")}-${table}-${part}.sql`, table, rows: statements.length, sql: header + statements.join("") });
      statements = []; bytes = 0;
    };
    for (const row of data.rows) {
      const statement = `${prefix}${columns.map(column => sqlLiteral(row[column])).join(",")});\n`, size = Buffer.byteLength(statement);
      if (size > D1_STATEMENT_LIMIT) warnings.push(`${table}: a row produces a ${size}-byte INSERT, above D1's ${D1_STATEMENT_LIMIT}-byte statement limit; it may be rejected remotely.`);
      if (statements.length && (statements.length >= maxRows || bytes + size > maxBytes)) flush();
      statements.push(statement); bytes += size;
    }
    flush();
    plan.push({ table, rows: data.rows.length, columns: columns.length, droppedColumns: dropped, files: part });
  }
  return { files, warnings, plan };
}

const NOT_INTERNAL = "m.type='table' AND m.name NOT LIKE 'sqlite\\_%' ESCAPE '\\' AND m.name NOT LIKE '\\_cf\\_%' ESCAPE '\\'";
/** Reads target columns and foreign-key parents. query(sql) must resolve to result rows. */
export async function readTargetSchema(query) {
  const columns = new Map(), dependencies = new Map();
  for (const row of await query(`SELECT m.name AS tbl, p.name AS col FROM sqlite_master m JOIN pragma_table_info(m.name) p WHERE ${NOT_INTERNAL} ORDER BY m.name, p.cid`)) {
    if (!columns.has(row.tbl)) columns.set(row.tbl, []);
    columns.get(row.tbl).push(row.col);
  }
  for (const row of await query(`SELECT DISTINCT m.name AS tbl, f."table" AS parent FROM sqlite_master m JOIN pragma_foreign_key_list(m.name) f WHERE ${NOT_INTERNAL}`)) {
    if (!dependencies.has(row.tbl)) dependencies.set(row.tbl, []);
    dependencies.get(row.tbl).push(row.parent);
  }
  return { columns, dependencies };
}

// One row of scalar subqueries per 50 tables: D1/workerd cap compound SELECTs (UNION ALL) at a handful of terms.
export async function countRows(query, tables) {
  const counts = {};
  for (let start = 0; start < tables.length; start += 50) {
    const chunk = tables.slice(start, start + 50);
    const [row] = await query(`SELECT ${chunk.map(table => `(SELECT COUNT(*) FROM ${quote(table)}) AS ${quote(table)}`).join(", ")}`);
    for (const table of chunk) counts[table] = Number(row[table]);
  }
  return counts;
}

const execFileAsync = promisify(execFile);
function wranglerRunner({ remote, config, persistTo }) {
  const target = [remote ? "--remote" : "--local", ...(config ? ["--config", config] : []), ...(persistTo && !remote ? ["--persist-to", persistTo] : [])];
  const run = async args => {
    try { return (await execFileAsync("pnpm", ["exec", "wrangler", ...args, ...target], { cwd: projectRoot, maxBuffer: 512 * 1024 * 1024 })).stdout; }
    catch (error) { throw new Error(`wrangler ${args.slice(0, 3).join(" ")} failed: ${String(error.stderr || error.stdout || error.message).trim().slice(-2000)}`); }
  };
  return {
    run,
    async query(database, sql) {
      const stdout = await run(["d1", "execute", database, "--command", sql, "--json", "--yes"]);
      const parsed = JSON.parse(stdout.slice(stdout.indexOf("[")));
      return parsed.flatMap(result => result.results || []);
    },
  };
}

// wrangler r2 wants a bucket name; accept a binding name (e.g. BUCKET) from --config too, for local rehearsals.
function resolveBucket(bucket, config) {
  if (!config) return bucket;
  try { return JSON.parse(fs.readFileSync(config, "utf8")).r2_buckets?.find(item => item.binding === bucket)?.bucket_name || bucket; } catch { return bucket; }
}

function loadExport(inDir) {
  const tablesDir = path.join(inDir, "tables");
  if (!fs.existsSync(tablesDir) || !fs.existsSync(path.join(inDir, "manifest.json"))) throw new Error(`${inDir} is not an export directory (expected tables/ and manifest.json).`);
  const exports = fs.readdirSync(tablesDir).filter(file => file.endsWith(".json")).sort().map(file => JSON.parse(fs.readFileSync(path.join(tablesDir, file), "utf8")));
  return { exports, objects: JSON.parse(fs.readFileSync(path.join(inDir, "manifest.json"), "utf8")).objects || [] };
}

async function main() {
  const { values } = parseArgs({ options: { in: { type: "string" }, database: { type: "string" }, bucket: { type: "string" }, local: { type: "boolean" }, remote: { type: "boolean" }, "dry-run": { type: "boolean" }, force: { type: "boolean" }, config: { type: "string" }, "persist-to": { type: "string" } } });
  if (!values.in || !values.database || !values.bucket || Boolean(values.local) === Boolean(values.remote)) throw new Error("Usage: node scripts/import-to-cloudflare.mjs --in ./migration-export --database clientrecord-crm-db --bucket clientrecord-crm-files (--local|--remote) [--dry-run] [--force] [--config wrangler.json] [--persist-to dir]");
  const inDir = path.resolve(values.in), remote = Boolean(values.remote), dryRun = Boolean(values["dry-run"]);
  const wrangler = wranglerRunner({ remote, config: values.config && path.resolve(values.config), persistTo: values["persist-to"] && path.resolve(values["persist-to"]) });
  const query = sql => wrangler.query(values.database, sql), bucket = resolveBucket(values.bucket, values.config && path.resolve(values.config));
  const { exports, objects } = loadExport(inDir);
  const where = `${remote ? "remote" : "local"} D1 "${values.database}" / R2 "${bucket}"`;
  console.log(`Importing ${exports.length} tables and ${objects.length} objects from ${inDir} into ${where}${dryRun ? " (dry run)" : ""}`);

  const schema = await readTargetSchema(query);
  const missing = exports.map(item => item.table).filter(table => !schema.columns.has(table));
  if (missing.length) throw new Error(`The target is missing tables: ${missing.join(", ")}. Apply the migrations first.`);
  const exportedCounts = Object.fromEntries(exports.map(item => [item.table, item.rows.length]));
  const before = await countRows(query, exports.map(item => item.table));
  const occupied = Object.entries(before).filter(([table, count]) => count > 0 && exportedCounts[table] > 0);
  if (occupied.length && !values.force) throw new Error(`Refusing to import into tables that already contain rows: ${occupied.map(([table, count]) => `${table} (${count})`).join(", ")}. Use --force to insert anyway.`);

  const order = topoSort(exports.map(item => item.table), schema.dependencies);
  const { files, warnings, plan } = buildImportSql({ exports, targetColumns: schema.columns, order });
  const sqlDir = path.join(inDir, "import-sql");
  fs.rmSync(sqlDir, { recursive: true, force: true });
  fs.mkdirSync(sqlDir, { recursive: true });
  for (const file of files) fs.writeFileSync(path.join(sqlDir, file.name), file.sql);
  for (const warning of warnings) console.warn(`warning: ${warning}`);
  console.log(`Plan (FK-safe order), SQL in ${sqlDir}:`);
  for (const item of plan) console.log(`  ${item.table}: ${item.rows} rows in ${item.files} file(s)${item.droppedColumns.length ? `, dropping ${item.droppedColumns.join(", ")}` : ""}`);
  console.log(`  R2: ${objects.length} objects`);
  if (dryRun) { console.log("Dry run: nothing executed."); return; }

  for (const [index, file] of files.entries()) {
    console.log(`  [${index + 1}/${files.length}] ${file.name} (${file.rows} rows)`);
    await wrangler.run(["d1", "execute", values.database, "--file", path.join(sqlDir, file.name), "--yes"]);
  }
  const objectProblems = [];
  let uploaded = 0;
  for (const [index, entry] of objects.entries()) {
    let file;
    try { file = safeObjectPath(inDir, entry.key); } catch (error) { objectProblems.push(error.message); continue; }
    if (!fs.existsSync(file)) { objectProblems.push(`missing local file for ${entry.key}`); continue; }
    if (/^[0-9a-f]{64}$/i.test(String(entry.checksum || "")) && sha256File(file) !== String(entry.checksum).toLowerCase()) { objectProblems.push(`checksum mismatch for ${entry.key}`); continue; }
    console.log(`  [${index + 1}/${objects.length}] r2 ${entry.key}`);
    try { await wrangler.run(["r2", "object", "put", `${bucket}/${entry.key}`, "--file", file, "--content-type", entry.contentType || "application/octet-stream"]); uploaded++; }
    catch (error) { objectProblems.push(`upload failed for ${entry.key}: ${error.message}`); }
  }

  const after = await countRows(query, exports.map(item => item.table));
  const mismatches = exports.filter(item => after[item.table] !== (before[item.table] || 0) + item.rows.length).map(item => `${item.table}: expected ${(before[item.table] || 0) + item.rows.length}, found ${after[item.table]}`);
  const rowCount = exports.reduce((sum, item) => sum + item.rows.length, 0);
  console.log(`\nImported ${rowCount} rows into ${exports.length} tables and uploaded ${uploaded}/${objects.length} objects.`);
  for (const problem of [...mismatches, ...objectProblems]) console.error(`  MISMATCH ${problem}`);
  if (mismatches.length || objectProblems.length || uploaded !== objects.length) { console.error("Verification failed."); process.exitCode = 1; }
  else console.log("Verification passed: row counts and object count match the export.");
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main().catch(error => { console.error(error.message); process.exit(1); });
