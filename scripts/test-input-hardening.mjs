import assert from "node:assert/strict";
import { createTestContext } from "./test-helpers.mjs";

const { sqlite, env, load } = createTestContext();
const objects = new Map();
env.BUCKET = {
  async put(key, value, options) { objects.set(key, { bytes: new Uint8Array(value), type: options?.httpMetadata?.contentType }); },
  async get(key) { const item = objects.get(key); if (!item) return null; return { body: item.bytes, arrayBuffer: async () => item.bytes.buffer, text: async () => new TextDecoder().decode(item.bytes) }; },
  async delete(key) { objects.delete(key); },
};
const headers = email => ({ "oai-authenticated-user-id": `user-${email}`, "oai-authenticated-user-email": email, "content-type": "application/json" });
const owner = "owner@example.com", editor = "editor@example.com", viewer = "viewer@example.com";
sqlite.exec(`
INSERT INTO team_members(email,name,role,created_at,updated_at) VALUES ('${editor}','Eddie Editor','editor','now','now'),('${viewer}','Vera Viewer','viewer','now','now');
INSERT INTO contacts(id,first_name,last_name,email,company,created_at,updated_at) VALUES (1,'Casey','Client','casey@acme.test','Acme','now','now');
INSERT INTO deals(id,name,company,contact_id,stage,status,created_at,updated_at) VALUES (1,'Acme expansion','Acme',1,'Proposal','Open','now','now');
INSERT INTO deal_proposals(id,deal_id,title,status,share_token,created_by,created_at,updated_at) VALUES (1,1,'Acme proposal','Sent','secret-share-token-1234567890','${owner}','now','now');
`);
const bytes = text => new TextEncoder().encode(text);
function seedDocument(id, { type, sensitive = 0, filename = `${id}.bin` }) {
  sqlite.prepare("INSERT INTO client_documents(id,title,deal_id,sensitive,status,latest_version,created_by,created_at,updated_at) VALUES (?,?,1,?,'Active',1,?,'now','now')").run(id, id, sensitive, owner);
  sqlite.prepare("INSERT INTO document_versions(id,document_id,version,object_key,filename,content_type,size,checksum,uploaded_by,uploaded_at) VALUES (?,?,1,?,?,?,4,'x',?,'now')").run(`${id}-v1`, id, `client-documents/${id}`, filename, type, owner);
  objects.set(`client-documents/${id}`, { bytes: bytes("data"), type });
}

// 1. Attachments synced from email cannot be stored or served as active content.
const { saveCommunicationAttachment } = load("lib/client-documents.ts");
for (const hostile of ["image/svg+xml", "text/html", "text/xml", "application/xhtml+xml"]) {
  const saved = await saveCommunicationAttachment({ filename: "invoice.svg", contentType: hostile, bytes: bytes("<svg onload=alert(1)>"), dealId: 1, contactId: 1, actor: owner, source: "Google" });
  assert.ok(saved, `${hostile} attachment is still kept`);
  const version = sqlite.prepare("SELECT v.content_type AS type FROM document_versions v JOIN client_documents d ON d.id=v.document_id WHERE d.id=?").get(saved.id ?? saved.documentId ?? saved);
  assert.equal(version.type, "application/octet-stream", `${hostile} is neutralised when stored`);
}
const pdf = await saveCommunicationAttachment({ filename: "quote.pdf", contentType: "application/pdf", bytes: bytes("%PDF"), dealId: 1, contactId: 1, actor: owner, source: "Google" });
assert.equal(sqlite.prepare("SELECT content_type AS type FROM document_versions WHERE document_id=?").get(pdf.id ?? pdf.documentId ?? pdf).type, "application/pdf", "safe types are kept");

const documents = load("app/api/documents/route.ts");
const download = async (id, email = owner) => documents.GET(new Request(`https://crm.example.com/api/documents?id=${id}&preview=1`, { headers: headers(email) }));
seedDocument("legacy-html", { type: "text/html" });
seedDocument("legacy-svg", { type: "image/svg+xml" });
seedDocument("safe-pdf", { type: "application/pdf" });
seedDocument("safe-png", { type: "image/png" });
for (const id of ["legacy-html", "legacy-svg"]) {
  const response = await download(id);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("content-type"), "application/octet-stream", `${id} is never served with an active type`);
  assert.match(response.headers.get("content-disposition"), /^attachment;/, `${id} downloads instead of rendering`);
  assert.match(response.headers.get("content-security-policy") || "", /default-src 'none'/, `${id} carries a restrictive CSP`);
}
for (const [id, type] of [["safe-pdf", "application/pdf"], ["safe-png", "image/png"]]) {
  const response = await download(id);
  assert.equal(response.headers.get("content-type"), type);
  assert.match(response.headers.get("content-disposition"), /^inline;/, `${id} still previews inline`);
  const csp = response.headers.get("content-security-policy") || "";
  if (type === "application/pdf") { assert.match(csp, /frame-ancestors 'none'/); assert.doesNotMatch(csp, /object-src|sandbox/, "inline PDFs must not block the browser's PDF viewer"); }
  else assert.match(csp, /default-src 'none'/);
}

// 2. Proposal share tokens are only visible to people who can send proposals.
const proposals = load("app/api/proposal-management/route.ts");
const listProposals = async email => (await proposals.GET(new Request("https://crm.example.com/api/proposal-management", { headers: headers(email) }))).json();
const viewerList = await listProposals(viewer), editorList = await listProposals(editor);
assert.equal(viewerList.proposals.length, 1);
assert.equal("share_token" in viewerList.proposals[0], false, "viewers never receive the raw token");
assert.equal(viewerList.proposals[0].shareUrl, null, "viewers never receive the share link");
assert.equal("share_token" in editorList.proposals[0], false, "the raw token is never sent to the browser");
assert.equal(editorList.proposals[0].shareUrl, "https://crm.example.com/proposal/secret-share-token-1234567890", "editors can still copy the link");
const dealWorkspace = load("app/api/deal-workspace/route.ts");
const workspace = await (await dealWorkspace.GET(new Request("https://crm.example.com/api/deal-workspace?dealId=1", { headers: headers(viewer) }))).json();
assert.ok(!JSON.stringify(workspace).includes("secret-share-token-1234567890"), "deal workspace never leaks the share token");

// 3. Sensitive documents stay out of the shared inbox for users without sensitive access.
seedDocument("sensitive-nda", { type: "application/pdf", sensitive: 1 });
const inbox = load("app/api/shared-inbox/route.ts");
const inboxDocs = async email => (await (await inbox.GET(new Request("https://crm.example.com/api/shared-inbox", { headers: headers(email) }))).json()).documents.map(doc => doc.id);
assert.equal((await inboxDocs(editor)).includes("sensitive-nda"), false, "editors do not see sensitive documents in the attachment picker");
assert.equal((await inboxDocs(viewer)).includes("sensitive-nda"), false, "viewers do not see sensitive documents either");
assert.equal((await inboxDocs(owner)).includes("sensitive-nda"), true, "owners still see them");
let resendCalls = 0;
globalThis.fetch = async () => { resendCalls++; return Response.json({ id: "email-1" }); };
env.RESEND_API_KEY = "re_test"; env.RESEND_FROM_EMAIL = "crm@example.com";
const send = await inbox.POST(new Request("https://crm.example.com/api/shared-inbox", { method: "POST", headers: headers(editor), body: JSON.stringify({ action: "send", to: "outsider@evil.test", subject: "Contract", body: "See attached", attachmentDocumentIds: ["sensitive-nda"] }) }));
assert.ok(send.status >= 400, "an editor cannot email a sensitive document");
assert.equal(resendCalls, 0, "nothing is sent to Resend");
const allowed = await inbox.POST(new Request("https://crm.example.com/api/shared-inbox", { method: "POST", headers: headers(editor), body: JSON.stringify({ action: "send", to: "casey@acme.test", subject: "Quote", body: "Attached", attachmentDocumentIds: ["safe-pdf"] }) }));
assert.equal(allowed.status < 400, true, `non-sensitive attachments still send (got ${allowed.status})`);

console.log("PASS: synced attachments neutralised and never rendered as active content, proposal share tokens hidden from viewers and API responses, sensitive documents blocked from the shared inbox.");
