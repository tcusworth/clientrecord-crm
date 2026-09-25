// Owner-only data export (/api/backup-export) plus the export-from-live / import-to-cloudflare migration scripts.
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createSqlite, createTestContext } from "./test-helpers.mjs";
import { runExport, safeObjectPath } from "./export-from-live.mjs";
import { buildImportSql, readTargetSchema, sqlLiteral, topoSort } from "./import-to-cloudflare.mjs";

const { sqlite, env, load } = createTestContext();
const objects = new Map();
env.BUCKET = {
  async put(key, value, options) { objects.set(key, { bytes: new Uint8Array(value), type: options?.httpMetadata?.contentType }); },
  async get(key) { const item = objects.get(key); return item ? { body: item.bytes, arrayBuffer: async () => item.bytes.buffer, text: async () => new TextDecoder().decode(item.bytes) } : null; },
  async head(key) { const item = objects.get(key); return item ? { size: item.bytes.byteLength, httpMetadata: { contentType: item.type } } : null; },
  async delete(key) { objects.delete(key); },
};
const sha256 = bytes => crypto.createHash("sha256").update(bytes).digest("hex");
const owner = "owner@example.com", admin = "admin@example.com", editor = "editor@example.com", viewer = "viewer@example.com";
const signedIn = email => ({ "oai-authenticated-user-id": `user-${email}`, "oai-authenticated-user-email": email });
const bearer = raw => ({ authorization: `Bearer ${raw}` });

// ---- Seed a realistic dataset -------------------------------------------------------------------
const tricky = "O'Brien said \"hi\" 👋 — 東京 · שלום\r\nline two\ttab \\back\\slash '; DROP TABLE contacts; -- end";
sqlite.exec(`
INSERT INTO team_members(email,name,role,created_at,updated_at) VALUES ('${admin}','Ada Admin','admin','now','now'),('${editor}','Eddie Editor','editor','now','now'),('${viewer}','Vera Viewer','viewer','now','now');
INSERT INTO companies(id,name,updated_at,enriched_at,notes) VALUES (1,'Acme Ünïcode Ltd','2026-01-01','2026-02-03T04:05:06Z',''),(2,'Globex','2026-01-02',NULL,'plain');
`);
const insertContact = sqlite.prepare("INSERT INTO contacts(id,first_name,last_name,email,company,tags,subscribed,notes,created_at,phone) VALUES (?,?,?,?,?,?,?,?,?,?)");
insertContact.run(1, "Casey", "Client", "casey@acme.test", "Acme", '["vip","q3"]', 1, tricky, "2026-01-01T00:00:00Z", "");
insertContact.run(2, "=HYPERLINK(\"http://evil.test\")", "Formula", "formula@acme.test", "Acme", "[]", 0, "", "2026-01-02T00:00:00Z", "+1 555 0100");
insertContact.run(3, "Zoë", "Ünicode", "zoe@globex.test", "Globex", "[]", 1, "multi\nline\nnote", "2026-01-03T00:00:00Z", "");
sqlite.exec(`
INSERT INTO deals(id,name,company,contact_id,company_id,stage,status,value,probability,created_at,updated_at) VALUES (1,'Acme expansion','Acme',1,1,'Proposal','Open',1234.5,35,'now','now'),(2,'Globex refund','Globex',3,2,'Closed','Lost',-250,0,'now','now');
INSERT INTO deal_proposals(id,deal_id,title,status,share_token,created_by,created_at,updated_at) VALUES (1,1,'Acme proposal','Sent','share-token-abcdefghijklmnop','${owner}','now','now');
INSERT INTO audit_logs(actor_email,action,entity_type,entity_id,summary,changes,created_at) VALUES ('${owner}','seed','contact','1','Seeded','{}','now');
`);
const documentBytes = { text: new TextEncoder().encode(`Meeting notes: ${tricky}`), binary: Uint8Array.from({ length: 256 }, (_, index) => index), legacy: new TextEncoder().encode("legacy upload") };
function seedDocument(id, bytes, { sensitive = 0, type = "application/pdf", checksum = sha256(bytes), filename = `${id}.bin` } = {}) {
  sqlite.prepare("INSERT INTO client_documents(id,title,deal_id,sensitive,status,latest_version,created_by,created_at,updated_at) VALUES (?,?,1,?,'Active',1,?,'now','now')").run(id, `Doc ${id}`, sensitive, owner);
  sqlite.prepare("INSERT INTO document_versions(id,document_id,version,object_key,filename,content_type,size,checksum,uploaded_by,uploaded_at) VALUES (?,?,1,?,?,?,?,?,?,'now')").run(`${id}-v1`, id, `client-documents/${id}/v1-${id}`, filename, type, bytes.byteLength, checksum, owner);
  objects.set(`client-documents/${id}/v1-${id}`, { bytes, type });
}
seedDocument("doc-text", documentBytes.text, { type: "text/plain", filename: "notes.txt" });
seedDocument("doc-binary", documentBytes.binary, { sensitive: 1, filename: "contract.pdf" });
seedDocument("doc-legacy", documentBytes.legacy, { checksum: "legacy-not-a-sha", filename: "legacy.pdf" });
const audioBytes = Uint8Array.from([26, 69, 223, 163, 1, 2, 3]), imageBytes = Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10]);
sqlite.exec(`INSERT INTO field_captures(id,type,note,contact_id,company_id,audio_object_key,attachment_object_key,latitude,longitude,accuracy,captured_by,captured_at) VALUES ('cap-1','Voice memo','Parking lot chat',1,1,'field-captures/user-1/cap-1.webm','field-captures/user-1/cap-1.jpg','51.5','-0.12',12,'${owner}','now'),('cap-2','Quick note','No media',NULL,NULL,NULL,NULL,NULL,NULL,NULL,'${owner}','now')`);
objects.set("field-captures/user-1/cap-1.webm", { bytes: audioBytes, type: "audio/webm" });
objects.set("field-captures/user-1/cap-1.jpg", { bytes: imageBytes, type: "image/png" });
// Denylisted tables and objects that must never leave through the export.
sqlite.exec(`
INSERT INTO integration_accounts(provider,access_token,refresh_token,expires_at,created_at,updated_at) VALUES ('google','enc-access','enc-refresh','2030-01-01','now','now');
INSERT INTO oauth_states(state,actor_email,expires_at,created_at) VALUES ('state-1','${owner}','2030-01-01','now');
INSERT INTO rate_limits(key,window_start,count) VALUES ('ip:1','now',3);
INSERT INTO webhook_endpoints(id,name,url,events,secret_encrypted,active,created_at) VALUES ('wh-1','Hook','https://hooks.example.com','*','enc-secret',0,'now');
INSERT INTO backup_snapshots(id,object_key,status,created_by,created_at) VALUES ('snap-1','backups/snap-1.json','Complete','${owner}','now');
CREATE TABLE d1_migrations(id INTEGER PRIMARY KEY, name TEXT);
CREATE TABLE "__drizzle_migrations"(id INTEGER PRIMARY KEY, hash TEXT);
CREATE TABLE "_cf_METADATA"(key INTEGER PRIMARY KEY, value BLOB);
`);
objects.set("backups/snap-1.json", { bytes: new TextEncoder().encode("{}"), type: "application/json" });
const apiKeys = {};
for (const [name, scopes, revoked] of [["export", "backups.export", null], ["read", "records.read", null], ["star", "*", null], ["revoked", "backups.export", "now"]]) {
  const raw = `cr_live_${name}_${crypto.randomBytes(12).toString("hex")}`;
  apiKeys[name] = raw;
  sqlite.prepare("INSERT INTO api_keys(id,name,key_hash,key_prefix,scopes,revoked_at,created_by,created_at) VALUES (?,?,?,?,?,?,?,'now')").run(`key-${name}`, name, sha256(raw), raw.slice(0, 16), scopes, revoked, owner);
}

const route = load("app/api/backup-export/route.ts");
const get = (query, headers = {}) => route.GET(new Request(`https://crm.example.com/api/backup-export?${query}`, { headers }));
const getJson = async (query, headers = signedIn(owner)) => { const response = await get(query, headers); assert.equal(response.status, 200, `${query} → ${response.status}`); return response.json(); };

// ---- 1. Access: owner or a backups.export key only ------------------------------------------------
assert.equal((await get("part=tables")).status, 401, "anonymous callers are rejected");
for (const email of [admin, editor, viewer]) for (const query of ["part=tables", "part=manifest", "table=contacts", "object=client-documents/doc-text/v1-doc-text"]) assert.equal((await get(query, signedIn(email))).status, 403, `${email} cannot use ${query}`);
assert.equal((await get("part=tables", bearer(apiKeys.read))).status, 403, "keys with other scopes are rejected");
assert.equal((await get("part=tables", bearer(apiKeys.star))).status, 403, "the all-scope (*) key does not grant a full data export");
assert.equal((await get("part=tables", bearer(apiKeys.revoked))).status, 403, "revoked export keys are rejected");
assert.equal((await get("part=tables", signedIn(owner))).status, 200, "owners can export");
assert.equal((await get("part=tables", bearer(apiKeys.export))).status, 200, "backups.export keys can export");
assert.equal((await get("", signedIn(owner))).status, 400, "a mode is required");

// ---- 2. Table discovery -----------------------------------------------------------------------
const { BACKUP_EXPORT_EXCLUDED_TABLES } = load("lib/backup-export.ts");
const discovery = await getJson("part=tables");
const tableNames = discovery.tables.map(table => table.name);
for (const table of ["contacts", "companies", "deals", "deal_proposals", "client_documents", "document_versions", "field_captures", "api_keys", "audit_logs", "team_members"]) assert.ok(tableNames.includes(table), `${table} is exported`);
for (const table of ["oauth_states", "rate_limits", "action_undo_log", "integration_accounts", "backup_snapshots", "webhook_endpoints", "webhook_deliveries"]) {
  assert.ok(!tableNames.includes(table), `${table} is excluded`);
  assert.equal(typeof BACKUP_EXPORT_EXCLUDED_TABLES[table], "string", `${table} has a documented reason`);
}
for (const table of ["sqlite_sequence", "d1_migrations", "__drizzle_migrations", "_cf_METADATA"]) assert.ok(!tableNames.includes(table), `internal table ${table} is excluded`);
assert.deepEqual(discovery.excluded.map(item => item.name).sort(), Object.keys(BACKUP_EXPORT_EXCLUDED_TABLES).sort(), "excluded tables are reported with reasons");
const contactsInfo = discovery.tables.find(table => table.name === "contacts");
assert.equal(contactsInfo.rows, 3);
assert.ok(contactsInfo.columns.includes("first_name") && contactsInfo.columns.includes("lead_source"), "column names come from the live schema");

// ---- 3. Paging and validation -------------------------------------------------------------------
const page1 = await getJson("table=contacts&offset=0&limit=2"), page2 = await getJson("table=contacts&offset=2&limit=2");
assert.deepEqual(page1.rows.map(row => row.id), [1, 2]);
assert.equal(page1.nextOffset, 2);
assert.deepEqual(page2.rows.map(row => row.id), [3]);
assert.equal(page2.nextOffset, null, "the last page has no next offset");
assert.equal(page1.table, "contacts");
assert.deepEqual(page1.columns, contactsInfo.columns);
assert.equal(page1.rows[0].notes, tricky, "text survives exactly");
assert.equal(page1.rows[0].suppression_reason, null, "NULLs survive");
assert.equal((await getJson("table=contacts")).rows.length, 3, "default page size covers small tables");
for (const bad of ["limit=0", "limit=1001", "limit=abc", "offset=-1", "offset=1.5", "format=xml"]) assert.equal((await get(`table=contacts&${bad}`, signedIn(owner))).status, 400, `${bad} is rejected`);
for (const name of ["sqlite_master", "sqlite_sequence", "constructor", "__proto__", "toString", "contacts\"; DROP TABLE contacts; --", "\"contacts\"", "Contacts", "oauth_states", "integration_accounts", "webhook_endpoints", "d1_migrations", "_cf_METADATA", ""]) {
  assert.equal((await get(`table=${encodeURIComponent(name)}`, signedIn(owner))).status, 400, `table ${JSON.stringify(name)} is rejected`);
  assert.equal((await get(`table=${encodeURIComponent(name)}&format=csv`, signedIn(owner))).status, 400, `csv ${JSON.stringify(name)} is rejected`);
}
assert.equal(sqlite.prepare("SELECT COUNT(*) AS n FROM contacts").get().n, 3, "no injected SQL ran");

// ---- 4. CSV --------------------------------------------------------------------------------------
const csvResponse = await get("table=contacts&format=csv", signedIn(owner));
assert.equal(csvResponse.status, 200);
assert.match(csvResponse.headers.get("content-type"), /^text\/csv/);
assert.match(csvResponse.headers.get("content-disposition"), /^attachment; filename="contacts\.csv"/);
assert.equal(csvResponse.headers.get("x-content-type-options"), "nosniff");
const csvText = await csvResponse.text();
assert.equal(csvText.split("\r\n")[0], contactsInfo.columns.join(","), "the header row lists every column");
assert.ok(csvText.includes(`"'=HYPERLINK(""http://evil.test"")"`), "formula cells are neutralised");
assert.ok(csvText.includes("'+1 555 0100"), "leading + text is neutralised");
const dealsCsv = await (await get("table=deals&format=csv", signedIn(owner))).text();
assert.match(dealsCsv, /(^|,)-250(,|\r?$)/m, "negative numbers stay numeric");

// ---- 5. Object manifest --------------------------------------------------------------------------
const { objects: manifest } = await getJson("part=manifest");
const byKey = Object.fromEntries(manifest.map(entry => [entry.key, entry]));
assert.equal(manifest.length, 5, "three document versions and two field-capture media objects");
assert.deepEqual({ ...byKey["client-documents/doc-binary/v1-doc-binary"] }, { kind: "document_version", key: "client-documents/doc-binary/v1-doc-binary", filename: "contract.pdf", contentType: "application/pdf", size: 256, checksum: sha256(documentBytes.binary), documentId: "doc-binary", version: 1, sensitive: true });
assert.equal(byKey["client-documents/doc-text/v1-doc-text"].sensitive, false);
assert.equal(byKey["client-documents/doc-legacy/v1-doc-legacy"].checksum, null, "non-sha256 checksums are not advertised");
assert.equal(byKey["field-captures/user-1/cap-1.webm"].kind, "field_capture_audio");
assert.equal(byKey["field-captures/user-1/cap-1.jpg"].kind, "field_capture_attachment");
assert.equal(byKey["field-captures/user-1/cap-1.jpg"].contentType, "image/png", "field-capture content type comes from R2 metadata");
assert.equal(byKey["field-captures/user-1/cap-1.jpg"].size, imageBytes.byteLength);
assert.equal(byKey["field-captures/user-1/cap-1.jpg"].fieldCaptureId, "cap-1");
assert.equal(byKey["backups/snap-1.json"], undefined, "backup snapshots are not part of the manifest");

// ---- 6. Object download --------------------------------------------------------------------------
const objectResponse = await get(`object=${encodeURIComponent("client-documents/doc-binary/v1-doc-binary")}`, bearer(apiKeys.export));
assert.equal(objectResponse.status, 200);
assert.deepEqual(new Uint8Array(await objectResponse.arrayBuffer()), documentBytes.binary);
assert.equal(objectResponse.headers.get("content-type"), "application/octet-stream");
assert.match(objectResponse.headers.get("content-disposition"), /^attachment;/);
assert.equal(objectResponse.headers.get("x-content-type-options"), "nosniff");
assert.equal(objectResponse.headers.get("cache-control"), "no-store");
assert.equal((await get(`object=${encodeURIComponent("field-captures/user-1/cap-1.webm")}`, signedIn(owner))).status, 200, "field-capture media is served");
for (const key of ["backups/snap-1.json", "../client-documents/doc-binary/v1-doc-binary", "client-documents/doc-binary", "client-documents/%", "client-documents/doc-binary/v1-doc-binary' OR '1'='1", ""]) assert.equal((await get(`object=${encodeURIComponent(key)}`, signedIn(owner))).status, 404, `unlisted key ${JSON.stringify(key)} is not served`);

// ---- 7. Auditing ---------------------------------------------------------------------------------
const audits = sqlite.prepare("SELECT action,actor_email AS actor,entity_id AS entity FROM audit_logs WHERE action LIKE 'backup.export.%'").all();
const auditActions = new Set(audits.map(row => row.action));
for (const action of ["backup.export.tables", "backup.export.table", "backup.export.csv", "backup.export.manifest"]) assert.ok(auditActions.has(action), `${action} is audited`);
assert.ok(!auditActions.has("backup.export.object"), "object downloads are covered by the audited manifest, not logged one by one");
assert.equal(audits.filter(row => row.action === "backup.export.table" && row.entity === "contacts").length, 2, "one audit per table read (first page only), not per page");
assert.ok(audits.some(row => row.actor === owner), "key usage is attributed to the owner who created the key");

// ---- 8. Only owners can mint backups.export keys ---------------------------------------------------
const operations = load("app/api/operations/route.ts");
const createKey = async (scopes, email) => (await operations.POST(new Request("https://crm.example.com/api/operations", { method: "POST", headers: { ...signedIn(email), "content-type": "application/json" }, body: JSON.stringify({ action: "createApiKey", name: "export", scopes }) }))).status;
assert.equal(await createKey("backups.export", admin), 403, "admins cannot create export keys");
assert.equal(await createKey("records.read,backups.export", admin), 403, "not even mixed with other scopes");
assert.equal(await createKey("records.read", admin), 201, "admins still create ordinary keys");
assert.equal(await createKey("backups.export", owner), 201, "owners can create export keys");
const auth = load("lib/crm-auth.ts");
const exportKeyUser = await auth.apiKeyUser(new Request("https://crm.example.com", { headers: bearer(apiKeys.export) }), "backups.export");
assert.deepEqual(exportKeyUser.permissions, [], "backups.export grants no other permissions");
assert.equal(await auth.apiKeyUser(new Request("https://crm.example.com", { headers: bearer(apiKeys.export) }), "records.read"), null, "and satisfies no other scope");

// ---- 9. sqlLiteral / topoSort ----------------------------------------------------------------------
assert.equal(sqlLiteral(null), "NULL");
assert.equal(sqlLiteral(undefined), "NULL");
assert.equal(sqlLiteral(true), "1");
assert.equal(sqlLiteral(false), "0");
assert.equal(sqlLiteral(42), "42");
assert.equal(sqlLiteral(-1.5), "-1.5");
assert.equal(sqlLiteral(1e21), "1e+21");
assert.equal(sqlLiteral(10n), "10");
assert.equal(sqlLiteral("O'Brien"), "'O''Brien'");
assert.equal(sqlLiteral("''"), "''''''");
assert.equal(sqlLiteral("a\nb"), "'a\nb'");
assert.equal(sqlLiteral([0, 255, 16]), "X'00FF10'");
assert.equal(sqlLiteral(new Uint8Array([1, 2])), "X'0102'");
assert.match(sqlLiteral("nul\u0000x"), /^CAST\(X'6E756C0078' AS TEXT\)$/);
// node:sqlite truncates strings at NUL when reading them back, so check the stored bytes instead.
assert.equal(createSqlite({ migrations: [] }).prepare(`SELECT hex(${sqlLiteral("nul\u0000x")}) AS h`).get().h, "6E756C0078");
for (const bad of [NaN, Infinity, {}, [256], [1.5]]) assert.throws(() => sqlLiteral(bad), TypeError);
const probe = createSqlite({ migrations: [] });
for (const value of [tricky, "", "''", "\\", "--", "/* x */", "emoji 👋🏽", "trailing '"]) assert.equal(probe.prepare(`SELECT ${sqlLiteral(value)} AS v`).get().v, value, `literal round-trips ${JSON.stringify(value)}`);
for (const value of [0, -0, 9007199254740991, -42, 0.1 + 0.2, 1234.5]) assert.equal(probe.prepare(`SELECT ${sqlLiteral(value)} AS v`).get().v, Object.is(value, -0) ? 0 : value);
assert.deepEqual(new Uint8Array(probe.prepare(`SELECT ${sqlLiteral(Array.from(documentBytes.binary))} AS v`).get().v), documentBytes.binary);
assert.deepEqual(topoSort(["deals", "contacts", "companies"], { deals: ["contacts", "companies"], contacts: ["companies"] }), ["companies", "contacts", "deals"]);
assert.deepEqual(topoSort(["b", "a"], new Map([["a", ["a"]], ["b", ["a", "missing"]]])), ["a", "b"], "self references and unknown parents are ignored");
assert.deepEqual(topoSort(["x", "y", "z"], { x: ["y"], y: ["x"] }).sort(), ["x", "y", "z"], "cycles still include every table once");

// ---- 10. Round trip: runExport → buildImportSql → fresh database -------------------------------------
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "crm-backup-export-"));
try {
  const fetchShim = async (url, init = {}) => route.GET(new Request(url, init));
  const noSleep = async () => {};
  assert.throws(() => safeObjectPath(tmp, "../evil"), /unsafe/i);
  assert.throws(() => safeObjectPath(tmp, "/etc/passwd"), /unsafe/i);
  assert.throws(() => safeObjectPath(tmp, "a/../../evil"), /unsafe/i);
  assert.throws(() => safeObjectPath(tmp, "C:\\evil"), /unsafe/i);
  assert.equal(safeObjectPath(tmp, "client-documents/a/v1"), path.join(tmp, "objects", "client-documents", "a", "v1"));

  let tableAttempts = 0;
  const flaky = async (url, init) => { if (url.includes("part=tables") && ++tableAttempts < 3) return new Response("busy", { status: 503 }); return fetchShim(url, init); };
  const exported = await runExport({ baseUrl: "https://crm.example.com", fetchImpl: flaky, outDir: tmp, headers: bearer(apiKeys.export), log: () => {}, pageSize: 2, sleep: noSleep });
  assert.equal(tableAttempts, 3, "transient 5xx responses are retried");
  assert.equal(exported.ok, true, JSON.stringify(exported.failures));
  assert.equal(exported.objectCount, 5);
  assert.equal(exported.objectsDownloaded, 5);
  assert.deepEqual(exported.checksumFailures, []);
  const info = JSON.parse(fs.readFileSync(path.join(tmp, "export-info.json"), "utf8"));
  assert.equal(info.sourceUrl, "https://crm.example.com");
  assert.equal(info.tables.contacts, 3);
  assert.equal(info.objectCount, 5);
  assert.ok(fs.existsSync(path.join(tmp, "csv", "contacts.csv")));
  assert.ok(!fs.existsSync(path.join(tmp, "tables", "oauth_states.json")), "denylisted tables are not written");
  const localManifest = JSON.parse(fs.readFileSync(path.join(tmp, "manifest.json"), "utf8")).objects;
  for (const entry of localManifest) assert.deepEqual(new Uint8Array(fs.readFileSync(safeObjectPath(tmp, entry.key))), objects.get(entry.key).bytes, `${entry.key} is written byte-for-byte`);

  // Resume: nothing is downloaded twice.
  let objectFetches = 0;
  const counting = async (url, init) => { if (url.includes("object=")) objectFetches++; return fetchShim(url, init); };
  const resumed = await runExport({ baseUrl: "https://crm.example.com", fetchImpl: counting, outDir: tmp, headers: signedIn(owner), log: () => {}, sleep: noSleep });
  assert.equal(resumed.ok, true);
  assert.equal(objectFetches, 0, "present objects with a matching checksum or size are skipped");
  assert.equal(resumed.objectsSkipped, 5);

  // A corrupted object is reported, not written, and fails the run.
  const textKey = "client-documents/doc-text/v1-doc-text", textPath = safeObjectPath(tmp, textKey), original = objects.get(textKey);
  fs.rmSync(textPath);
  objects.set(textKey, { ...original, bytes: new TextEncoder().encode("tampered") });
  const corrupted = await runExport({ baseUrl: "https://crm.example.com", fetchImpl: fetchShim, outDir: tmp, headers: signedIn(owner), log: () => {}, sleep: noSleep });
  assert.equal(corrupted.ok, false);
  assert.deepEqual(corrupted.checksumFailures.map(item => item.key), [textKey]);
  assert.ok(!fs.existsSync(textPath), "a mismatched download is not kept");
  objects.set(textKey, original);
  assert.equal((await runExport({ baseUrl: "https://crm.example.com", fetchImpl: fetchShim, outDir: tmp, headers: signedIn(owner), log: () => {}, sleep: noSleep })).ok, true, "a re-run repairs it");

  // Hostile manifest keys never escape the output directory.
  const evilDir = fs.mkdtempSync(path.join(os.tmpdir(), "crm-backup-evil-"));
  const hostile = async (url, init) => url.includes("part=manifest") ? Response.json({ objects: [{ kind: "document_version", key: "../../escaped.txt", checksum: null, size: 1 }] }) : fetchShim(url, init);
  const hostileRun = await runExport({ baseUrl: "https://crm.example.com", fetchImpl: hostile, outDir: path.join(evilDir, "out"), headers: signedIn(owner), log: () => {}, sleep: noSleep });
  assert.equal(hostileRun.ok, false);
  assert.ok(!fs.existsSync(path.join(evilDir, "escaped.txt")) && !fs.existsSync(path.join(os.tmpdir(), "escaped.txt")));
  fs.rmSync(evilDir, { recursive: true, force: true });

  // Import into a fresh database with every migration applied.
  const fresh = createSqlite();
  const schema = await readTargetSchema(async sql => fresh.prepare(sql).all());
  const exportedTables = fs.readdirSync(path.join(tmp, "tables")).sort().map(file => JSON.parse(fs.readFileSync(path.join(tmp, "tables", file), "utf8")));
  const order = topoSort(exportedTables.map(table => table.table), schema.dependencies);
  assert.ok(order.indexOf("companies") < order.indexOf("contacts") || !schema.dependencies.get("contacts")?.includes("companies"));
  assert.ok(order.indexOf("deals") < order.indexOf("deal_proposals"), "parents are imported before children");
  assert.ok(order.indexOf("client_documents") < order.indexOf("document_versions"));
  const { files, warnings } = buildImportSql({ exports: exportedTables, targetColumns: schema.columns, order, maxRows: 2 });
  assert.deepEqual(warnings, []);
  assert.ok(files.filter(file => file.table === "contacts").length === 2, "tables are chunked by row count");
  for (const file of files) {
    assert.ok(file.sql.startsWith("PRAGMA defer_foreign_keys = on;\n"), `${file.name} defers foreign keys`);
    fresh.exec("BEGIN"); fresh.exec(file.sql); fresh.exec("COMMIT");
  }
  assert.equal(fresh.prepare("PRAGMA foreign_key_check").all().length, 0, "imported data satisfies every foreign key");
  const quote = name => `"${name.replaceAll('"', '""')}"`;
  const rowsOf = (db, table, columns) => JSON.stringify(db.prepare(`SELECT ${columns.map(quote).join(",")} FROM ${quote(table)} ORDER BY rowid`).all().map(row => ({ ...row })));
  for (const table of exportedTables) {
    assert.equal(rowsOf(fresh, table.table, table.columns), JSON.stringify(table.rows), `${table.table} imports identically`);
    if (table.table !== "audit_logs") assert.equal(rowsOf(fresh, table.table, table.columns), rowsOf(sqlite, table.table, table.columns), `${table.table} matches the source database`);
  }
  assert.equal(fresh.prepare("SELECT notes FROM contacts WHERE id=1").get().notes, tricky);
  assert.equal(fresh.prepare("SELECT value FROM deals WHERE id=1").get().value, 1234.5);
  for (const table of Object.keys(BACKUP_EXPORT_EXCLUDED_TABLES)) assert.equal(fresh.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n, 0, `${table} stays empty`);
  for (const entry of localManifest) if (entry.checksum) assert.equal(sha256(fs.readFileSync(safeObjectPath(tmp, entry.key))), entry.checksum, `${entry.key} matches its checksum`);

  // Column drift: extra export columns are dropped with a warning; missing target tables are refused.
  const drift = buildImportSql({ exports: [{ table: "companies", columns: ["id", "name", "updated_at", "legacy_column"], rows: [{ id: 9, name: "Drift", updated_at: "now", legacy_column: "x" }] }], targetColumns: schema.columns, order: ["companies"] });
  assert.equal(drift.warnings.length, 1);
  assert.match(drift.warnings[0], /legacy_column/);
  assert.ok(!drift.files[0].sql.includes("legacy_column"));
  assert.throws(() => buildImportSql({ exports: [{ table: "not_migrated", columns: ["id"], rows: [{ id: 1 }] }], targetColumns: schema.columns, order: ["not_migrated"] }), /not_migrated/);
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}

console.log("backup export tests passed");
