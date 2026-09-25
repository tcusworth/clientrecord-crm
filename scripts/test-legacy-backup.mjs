import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { convertLegacyBackup } from "./convert-legacy-backup.mjs";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "legacy-backup-"));
const sha = bytes => crypto.createHash("sha256").update(bytes).digest("hex");
const docBytes = Buffer.from("PK\u0003\u0004 fake docx bytes"), otherBytes = Buffer.from("unrelated download");
const backup = {
  exportedAt: "2026-09-25T21:01:06.572Z",
  contacts: [{ id: 1, first_name: "Ada", last_name: "O'Brien", email: "ada@example.com", notes: "line1\nline2 \"quoted\"" }, { id: 2, first_name: "Émile", last_name: "Zola", email: "emile@example.com", notes: null }],
  companies: [{ id: 1, name: "Acme" }],
  deals: [],
  client_documents: [{ id: "doc-1", title: "Proposal", status: "Active", sensitive: 0 }],
  document_versions: [{ id: "v-1", document_id: "doc-1", version: 1, object_key: "client-documents/doc-1/v1-abc", filename: "Proposal.docx", content_type: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", size: docBytes.length, checksum: sha(docBytes) }],
};
const backupPath = path.join(tmp, "crm-account-backup.json"), documentsDir = path.join(tmp, "documents"), outDir = path.join(tmp, "out");
fs.writeFileSync(backupPath, JSON.stringify(backup));
fs.mkdirSync(documentsDir);
fs.writeFileSync(path.join(documentsDir, "renamed by the browser (1).docx"), docBytes);
fs.writeFileSync(path.join(documentsDir, "something else.pdf"), otherBytes);

// Converts every table and maps the downloaded file to its storage key by checksum, whatever it was named.
const result = convertLegacyBackup({ backupPath, documentsDir, outDir, log: () => {} });
assert.equal(result.tables, 5);
assert.equal(result.rows, 5);
assert.equal(result.objects, 1);
const contacts = JSON.parse(fs.readFileSync(path.join(outDir, "tables", "contacts.json"), "utf8"));
assert.equal(contacts.table, "contacts");
assert.deepEqual(contacts.columns, ["id", "first_name", "last_name", "email", "notes"]);
assert.deepEqual(contacts.rows, backup.contacts, "rows are copied exactly, including quotes, newlines, unicode and NULLs");
const deals = JSON.parse(fs.readFileSync(path.join(outDir, "tables", "deals.json"), "utf8"));
assert.deepEqual(deals, { table: "deals", columns: [], rows: [] });
assert.equal(fs.existsSync(path.join(outDir, "tables", "exportedAt.json")), false, "non-table keys are skipped");
const manifest = JSON.parse(fs.readFileSync(path.join(outDir, "manifest.json"), "utf8"));
assert.equal(manifest.objects.length, 1);
assert.deepEqual({ ...manifest.objects[0] }, { kind: "document_version", key: "client-documents/doc-1/v1-abc", filename: "Proposal.docx", contentType: backup.document_versions[0].content_type, size: docBytes.length, checksum: sha(docBytes), documentId: "doc-1", version: 1 });
assert.deepEqual(fs.readFileSync(path.join(outDir, "objects", "client-documents", "doc-1", "v1-abc")), docBytes, "file stored under its object key");
assert.ok(fs.existsSync(path.join(outDir, "export-info.json")));

// Fails loudly when a document file is missing, and never writes outside the output folder.
fs.rmSync(path.join(documentsDir, "renamed by the browser (1).docx"));
assert.throws(() => convertLegacyBackup({ backupPath, documentsDir, outDir: path.join(tmp, "out2"), log: () => {} }), /Proposal\.docx/);
const traversal = { ...backup, document_versions: [{ ...backup.document_versions[0], object_key: "../../etc/passwd" }] };
fs.writeFileSync(path.join(documentsDir, "again.docx"), docBytes);
fs.writeFileSync(backupPath, JSON.stringify(traversal));
assert.throws(() => convertLegacyBackup({ backupPath, documentsDir, outDir: path.join(tmp, "out3"), log: () => {} }), /Unsafe|unsafe|\.\./);
fs.writeFileSync(backupPath, "not json");
assert.throws(() => convertLegacyBackup({ backupPath, documentsDir, outDir: path.join(tmp, "out4"), log: () => {} }), /JSON/);

fs.rmSync(tmp, { recursive: true, force: true });
console.log("PASS: legacy backup converts to the import format, files matched by checksum, missing files and unsafe keys rejected.");
