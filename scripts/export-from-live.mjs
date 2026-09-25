#!/usr/bin/env node
// Pulls a complete ClientRecord CRM export (every exportable table + every referenced R2 object) from a live
// deployment through /api/backup-export. No dependencies beyond Node 22.
//
//   CRM_EXPORT_KEY=cr_live_... [CF_ACCESS_CLIENT_ID=... CF_ACCESS_CLIENT_SECRET=...] \
//     node scripts/export-from-live.mjs --url https://clientrecordcrm.com --out ./migration-export
//
// Output: tables/<name>.json ({table, columns, rows}), csv/<name>.csv, manifest.json, objects/<key>, export-info.json.
// Re-running resumes: objects already on disk with a matching checksum (or size, when no checksum is known) are skipped.
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { fileURLToPath } from "node:url";

const SHA256 = /^[0-9a-f]{64}$/i;
const TABLE_NAME = /^[A-Za-z0-9_]+$/;

export class HttpError extends Error {
  constructor(message, status) { super(message); this.status = status; }
}

/** Resolves an R2 key to a path under <outDir>/objects, refusing anything that could escape it. */
export function safeObjectPath(outDir, key) {
  const unsafe = typeof key !== "string" || !key || key.length > 1024 || key.includes("\0") || key.includes("\\") || key.startsWith("/") || /^[A-Za-z]:/.test(key) || key.split("/").some(part => part === "" || part === "." || part === "..");
  const root = path.resolve(outDir, "objects"), target = unsafe ? "" : path.resolve(root, ...key.split("/"));
  if (unsafe || !target.startsWith(root + path.sep)) throw new Error(`Refusing unsafe object key ${JSON.stringify(key)}`);
  return target;
}

export function sha256File(file) { return crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex"); }

function writeAtomic(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = `${file}.partial`;
  fs.writeFileSync(temp, data);
  fs.renameSync(temp, file);
}

const defaultSleep = ms => new Promise(resolve => setTimeout(resolve, ms));

/** GET with retries on network errors, 429 and 5xx (exponential backoff). Redirects are errors: they mean Cloudflare Access wants a login. */
async function fetchWithRetry(url, { fetchImpl, headers, retries, sleep, log }) {
  for (let attempt = 0; ; attempt++) {
    let failure;
    try {
      const response = await fetchImpl(url, { headers, redirect: "manual" });
      if (response.status >= 200 && response.status < 300) return response;
      const label = new URL(url).search;
      if (response.status >= 300 && response.status < 400) throw new HttpError(`${label} was redirected (${response.status}) to ${response.headers.get("location") || "a login page"}. Cloudflare Access is asking for a login: set CF_ACCESS_CLIENT_ID/CF_ACCESS_CLIENT_SECRET for a service token allowed by a Service Auth policy.`, response.status);
      const detail = (await response.text().catch(() => "")).slice(0, 300);
      failure = new HttpError(`HTTP ${response.status} for ${label}${detail ? `: ${detail}` : ""}`, response.status);
      if (response.status !== 429 && response.status < 500) throw failure;
    } catch (error) {
      if (error instanceof HttpError && error.status < 500 && error.status !== 429) throw error;
      failure = error;
    }
    if (attempt >= retries) throw failure;
    const delay = Math.min(30_000, 500 * 2 ** attempt);
    log(`  retrying in ${delay} ms (${failure.message})`);
    await sleep(delay);
  }
}

async function readJson(response, url) {
  const type = response.headers.get("content-type") || "";
  if (!type.includes("json")) throw new Error(`Expected JSON from ${new URL(url).search} but got ${type || "no content type"} (is Cloudflare Access returning a login page?)`);
  return response.json();
}

/**
 * Runs the whole export. Returns a summary; `ok` is false when any object is missing, fails its checksum or cannot be fetched.
 * fetchImpl/sleep/log are injectable for tests.
 */
export async function runExport({ baseUrl, fetchImpl = globalThis.fetch, outDir, headers = {}, log = console.log, retries = 4, sleep = defaultSleep, pageSize = 1000 }) {
  const endpoint = new URL("/api/backup-export", baseUrl);
  const urlFor = params => { const url = new URL(endpoint); for (const [key, value] of Object.entries(params)) url.searchParams.set(key, String(value)); return url.toString(); };
  const request = url => fetchWithRetry(url, { fetchImpl, headers, retries, sleep, log });
  const getJson = async params => { const url = urlFor(params); return readJson(await request(url), url); };
  for (const dir of ["tables", "csv", "objects"]) fs.mkdirSync(path.join(outDir, dir), { recursive: true });

  const { tables } = await getJson({ part: "tables" });
  log(`Exporting ${tables.length} tables from ${baseUrl}`);
  const tableCounts = {};
  for (const table of tables) {
    if (!TABLE_NAME.test(table.name)) throw new Error(`Refusing unexpected table name ${JSON.stringify(table.name)}`);
    const rows = [];
    let columns = table.columns, offset = 0;
    while (offset !== null) {
      const page = await getJson({ table: table.name, offset, limit: pageSize });
      columns = page.columns;
      rows.push(...page.rows);
      offset = page.nextOffset;
    }
    writeAtomic(path.join(outDir, "tables", `${table.name}.json`), JSON.stringify({ table: table.name, columns, rows }));
    const csv = await request(urlFor({ table: table.name, format: "csv" }));
    writeAtomic(path.join(outDir, "csv", `${table.name}.csv`), Buffer.from(await csv.arrayBuffer()));
    tableCounts[table.name] = rows.length;
    log(`  ${table.name}: ${rows.length} rows`);
  }

  const manifest = await getJson({ part: "manifest" });
  writeAtomic(path.join(outDir, "manifest.json"), JSON.stringify(manifest, null, 2));
  const entries = manifest.objects || [];
  log(`Downloading ${entries.length} objects`);
  const summary = { objectsDownloaded: 0, objectsSkipped: 0, bytesDownloaded: 0, objectBytes: 0, checksumFailures: [], missing: [], failures: [] };
  for (const [index, entry] of entries.entries()) {
    const progress = `  [${index + 1}/${entries.length}] ${entry.key}`;
    let target;
    try { target = safeObjectPath(outDir, entry.key); } catch (error) { summary.failures.push({ key: entry.key, error: error.message }); log(`${progress} REJECTED: ${error.message}`); continue; }
    const expected = SHA256.test(String(entry.checksum || "")) ? String(entry.checksum).toLowerCase() : null;
    if (fs.existsSync(target)) {
      const size = fs.statSync(target).size;
      if (expected ? sha256File(target) === expected : entry.size != null && size === Number(entry.size)) { summary.objectsSkipped++; summary.objectBytes += size; continue; }
    }
    try {
      const response = await request(urlFor({ object: entry.key }));
      const bytes = Buffer.from(await response.arrayBuffer()), actual = crypto.createHash("sha256").update(bytes).digest("hex");
      if (expected && actual !== expected) { summary.checksumFailures.push({ key: entry.key, expected, actual }); fs.rmSync(target, { force: true }); log(`${progress} CHECKSUM MISMATCH`); continue; }
      writeAtomic(target, bytes);
      summary.objectsDownloaded++; summary.bytesDownloaded += bytes.length; summary.objectBytes += bytes.length;
      log(`${progress} (${bytes.length} bytes)`);
    } catch (error) {
      if (error instanceof HttpError && error.status === 404) { summary.missing.push(entry.key); log(`${progress} MISSING in storage`); }
      else { summary.failures.push({ key: entry.key, error: error.message }); log(`${progress} FAILED: ${error.message}`); }
    }
  }

  const rowCount = Object.values(tableCounts).reduce((sum, count) => sum + count, 0);
  const result = { ok: !summary.checksumFailures.length && !summary.missing.length && !summary.failures.length, sourceUrl: baseUrl, exportedAt: new Date().toISOString(), tableCount: tables.length, rowCount, tables: tableCounts, objectCount: entries.length, ...summary };
  writeAtomic(path.join(outDir, "export-info.json"), JSON.stringify(result, null, 2));
  return result;
}

async function main() {
  const { values } = parseArgs({ options: { url: { type: "string" }, out: { type: "string" } } });
  const key = process.env.CRM_EXPORT_KEY, accessId = process.env.CF_ACCESS_CLIENT_ID, accessSecret = process.env.CF_ACCESS_CLIENT_SECRET;
  if (!values.url || !values.out || !key) throw new Error("Usage: CRM_EXPORT_KEY=cr_live_... [CF_ACCESS_CLIENT_ID=... CF_ACCESS_CLIENT_SECRET=...] node scripts/export-from-live.mjs --url https://clientrecordcrm.com --out ./migration-export");
  if (Boolean(accessId) !== Boolean(accessSecret)) throw new Error("Set both CF_ACCESS_CLIENT_ID and CF_ACCESS_CLIENT_SECRET, or neither.");
  const headers = { authorization: `Bearer ${key}`, ...(accessId ? { "CF-Access-Client-Id": accessId, "CF-Access-Client-Secret": accessSecret } : {}) };
  const outDir = path.resolve(values.out);
  const result = await runExport({ baseUrl: values.url, outDir, headers });
  console.log(`\nExport ${result.ok ? "complete" : "INCOMPLETE"}: ${result.tableCount} tables, ${result.rowCount} rows, ${result.objectCount} objects (${result.objectsDownloaded} downloaded, ${result.objectsSkipped} already present), ${result.objectBytes} bytes → ${outDir}`);
  for (const failure of result.checksumFailures) console.error(`  checksum mismatch: ${failure.key} (expected ${failure.expected}, got ${failure.actual})`);
  for (const key of result.missing) console.error(`  missing in storage: ${key}`);
  for (const failure of result.failures) console.error(`  failed: ${failure.key}: ${failure.error}`);
  if (!result.ok) process.exitCode = 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main().catch(error => { console.error(error.message); process.exit(1); });
