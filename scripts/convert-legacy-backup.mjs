// Converts the single-file backup from the pre-migration app (GET /api/export?type=backup) plus a folder of
// downloaded document files into the directory layout scripts/import-to-cloudflare.mjs reads:
// tables/<name>.json, manifest.json, objects/<object key>, export-info.json.
// Document files are matched to their records by SHA-256, so whatever the browser named them does not matter.
//
// Usage: node scripts/convert-legacy-backup.mjs --backup ./migration-export/crm-account-backup.json \
//          --documents ./migration-export/documents --out ./migration-export/converted
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { safeObjectPath, sha256File } from "./export-from-live.mjs";

export function convertLegacyBackup({ backupPath, documentsDir, outDir, log = console.log }) {
  let backup;
  try { backup = JSON.parse(fs.readFileSync(backupPath, "utf8")); }
  catch (error) { throw new Error(`${backupPath} is not valid JSON (${error.message}).`); }
  if (!backup || typeof backup !== "object" || Array.isArray(backup)) throw new Error(`${backupPath} is not a ClientRecord backup.`);

  const tables = Object.entries(backup).filter(([, value]) => Array.isArray(value));
  const versions = backup.document_versions || [];
  const filesByChecksum = new Map();
  if (versions.length) {
    if (!fs.existsSync(documentsDir)) throw new Error(`Documents folder ${documentsDir} not found; download the ${versions.length} document file(s) first.`);
    for (const name of fs.readdirSync(documentsDir)) {
      const file = path.join(documentsDir, name);
      if (fs.statSync(file).isFile()) filesByChecksum.set(sha256File(file), file);
    }
  }
  const missing = versions.filter(row => !filesByChecksum.has(String(row.checksum || "").toLowerCase()));
  if (missing.length) throw new Error(`No downloaded file matches these documents (by SHA-256): ${missing.map(row => row.filename).join(", ")}`);
  const objectPaths = versions.map(row => [row, safeObjectPath(outDir, String(row.object_key))]);

  fs.mkdirSync(path.join(outDir, "tables"), { recursive: true });
  let rows = 0;
  for (const [table, list] of tables) {
    const columns = [...new Set(list.flatMap(row => Object.keys(row)))];
    fs.writeFileSync(path.join(outDir, "tables", `${table}.json`), JSON.stringify({ table, columns, rows: list }));
    rows += list.length;
  }
  const objects = objectPaths.map(([row, target]) => {
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.copyFileSync(filesByChecksum.get(String(row.checksum).toLowerCase()), target);
    return { kind: "document_version", key: String(row.object_key), filename: String(row.filename), contentType: String(row.content_type || "application/octet-stream"), size: Number(row.size), checksum: String(row.checksum).toLowerCase(), documentId: String(row.document_id), version: Number(row.version) };
  });
  fs.writeFileSync(path.join(outDir, "manifest.json"), JSON.stringify({ objects }, null, 2));
  fs.writeFileSync(path.join(outDir, "export-info.json"), JSON.stringify({ source: "legacy /api/export?type=backup", exportedAt: backup.exportedAt || null, convertedAt: new Date().toISOString(), tables: tables.length, rows, objects: objects.length }, null, 2));
  log(`Converted ${tables.length} tables (${rows} rows) and ${objects.length} document file(s) into ${outDir}`);
  return { tables: tables.length, rows, objects: objects.length };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { values } = parseArgs({ options: { backup: { type: "string" }, documents: { type: "string" }, out: { type: "string" } } });
  if (!values.backup || !values.out) { console.error("Usage: node scripts/convert-legacy-backup.mjs --backup <crm-account-backup.json> --documents <folder> --out <folder>"); process.exit(2); }
  try { convertLegacyBackup({ backupPath: values.backup, documentsDir: values.documents || path.join(path.dirname(values.backup), "documents"), outDir: values.out }); }
  catch (error) { console.error(error.message); process.exit(1); }
}
