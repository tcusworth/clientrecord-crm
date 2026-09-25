import assert from "node:assert/strict";
import { createTestContext } from "./test-helpers.mjs";
import { matchHeaders } from "../node_modules/vinext/dist/config/config-matchers.js";
import { applyConfigHeadersToResponse } from "../node_modules/vinext/dist/server/config-headers.js";

const { sqlite, load } = createTestContext({ RESEND_API_KEY: "re_test" });
const owner = "owner@example.com";
const headers = email => ({ "oai-authenticated-user-id": `user-${email}`, "oai-authenticated-user-email": email, "content-type": "application/json" });
const sent = [];
globalThis.fetch = async (url, init = {}) => { sent.push({ url: String(url), body: JSON.parse(init.body || "{}") }); return Response.json({ id: `email-${sent.length}` }); };
const xss = `<img src=x onerror=alert(1)>`;

// 1. CSV exports neutralise spreadsheet formulas; the JSON backup keeps raw values.
sqlite.exec(`INSERT INTO contacts(id,first_name,last_name,email,company,title,phone,created_at,updated_at,subscribed) VALUES
 (1,'=HYPERLINK("http://evil.test","x")','+Plus','casey@acme.test','@SUM(A1)','-2+3','\t=cmd','now','now',1),
 (2,'Safe','Person','safe@acme.test','Acme, Inc','Boss','555','now','now',1)`);
sqlite.prepare("INSERT INTO activities(contact_id,type,note,happened_at) VALUES (1,'Note',?,'now')").run("\r=1+1");
sqlite.exec(`INSERT INTO deals(id,name,company,stage,status,value,created_at,updated_at) VALUES (1,'=cmd|'' /C calc''!A0','Acme','Proposal','Open',-500,'now','now')`);
const exporter = load("app/api/export/route.ts");
const exportText = async type => { const response = await exporter.GET(new Request(`https://crm.example.com/api/export?type=${type}`, { headers: headers(owner) })); assert.equal(response.status, 200, `${type} export succeeds`); return response.text(); };
const contactsCsv = await exportText("contacts");
const casey = contactsCsv.split("\r\n").find(line => line.includes("casey@acme.test"));
assert.ok(casey.startsWith(`"'=HYPERLINK(""http://evil.test"",""x"")",'+Plus,casey@acme.test,'@SUM(A1),'-2+3,'\t=cmd,`), `formula cells are prefixed and quoting is kept: ${JSON.stringify(casey)}`);
assert.ok(contactsCsv.includes(`Safe,Person,safe@acme.test,"Acme, Inc",Boss,555,`), "ordinary cells are unchanged");
const activityCsv = await exportText("activity");
assert.ok(activityCsv.includes(`"'\r=1+1"`), "carriage-return cells are prefixed and quoted");
const dealsCsv = await exportText("deals");
assert.ok(dealsCsv.includes(`\n'=cmd|' /C calc'!A0,Acme,`), `deal names are neutralised: ${dealsCsv}`);
assert.ok(dealsCsv.includes(",-5,"), "numeric values such as negative amounts stay numeric");
const backup = JSON.parse(await exportText("backup"));
assert.equal(backup.contacts.find(row => row.id === 1).first_name, `=HYPERLINK("http://evil.test","x")`, "JSON backup is not altered");

// 2. Sequence emails escape contact merge values (and the plain-text step body) in HTML.
sqlite.exec(`INSERT INTO brand_settings(id,business_name,from_name,from_email,sending_domain,physical_address,updated_at) VALUES (1,'Acme','Acme','hello@acme.test','acme.test','1 Road','now')`);
sqlite.prepare("INSERT INTO contacts(id,first_name,last_name,email,created_at,updated_at,subscribed) VALUES (3,?,'Target','target@acme.test','now','now',1)").run(xss);
sqlite.exec(`INSERT INTO automation_sequences(id,name,created_at,updated_at) VALUES (1,'Welcome','now','now');
INSERT INTO automation_steps(sequence_id,step_order,delay_days,action_type,subject,body) VALUES (1,0,0,'email','Hi','Hi {{first_name}}, 5 < 6 & "quotes"\nSecond line');
INSERT INTO automation_enrollments(sequence_id,contact_id,current_step,status,next_run_at,enrolled_at) VALUES (1,3,0,'Active','2000-01-01 00:00:00','now');`);
const { runDueAutomations } = load("lib/operations.ts");
sent.length = 0;
const result = await runDueAutomations(owner);
assert.equal(result.processed, 1, "sequence step is processed");
const sequenceHtml = sent.find(item => item.url.endsWith("/emails")).body.html;
assert.ok(!sequenceHtml.includes("<img"), `contact name is escaped in sequence HTML: ${sequenceHtml}`);
assert.ok(sequenceHtml.includes("Hi &lt;img src=x onerror=alert(1)&gt;, 5 &lt; 6 &amp; &quot;quotes&quot;<br>Second line"), `plain-text body is escaped consistently with line breaks kept: ${sequenceHtml}`);

// 3. Brand test email escapes every stored identity value.
sqlite.prepare("UPDATE brand_settings SET business_name=?,physical_address=?,from_name=?,reply_to_email=?,logo_url=? WHERE id=1").run(`Acme ${xss}`, `1 Road\n<script>alert(2)</script>`, `Evil <b>`, `reply"<i>@acme.test`, `https://cdn.acme.test/logo.png?a=1&b="><script>alert(3)</script>'x`);
const brand = load("app/api/brand/route.ts");
sent.length = 0;
const testResponse = await brand.POST(new Request("https://crm.example.com/api/brand", { method: "POST", headers: headers(owner), body: JSON.stringify({ action: "test", to: "qa@acme.test" }) }));
assert.equal(testResponse.status, 200);
const brandHtml = sent.find(item => item.url.endsWith("/emails")).body.html;
for (const raw of ["<img src=x", "<script", "<b>", "<i>"]) assert.ok(!brandHtml.includes(raw), `brand test email does not contain raw ${raw}: ${brandHtml}`);
assert.ok(brandHtml.includes(`src="https://cdn.acme.test/logo.png?a=1&amp;b=&quot;&gt;&lt;script&gt;alert(3)&lt;/script&gt;&#39;x"`), `logo URL is attribute-escaped: ${brandHtml}`);
assert.ok(brandHtml.includes("1 Road<br>&lt;script&gt;"), "address line breaks are kept after escaping");

// 4. Email templates only link to a plain, escaped hostname.
const { buildEmailTemplates } = load("lib/email-templates.ts");
const good = buildEmailTemplates({ businessName: "Acme", sendingDomain: "news.example.com" }).find(t => t.id === "announcement");
assert.ok(good.html.includes(`href="https://example.com"`), "valid sending domains still link to the root site");
for (const hostile of [`news.evil.test"><script>alert(1)</script>`, `evil.test" onmouseover="alert(1)`, `javascript:alert(1)`, `evil.test/"x`]) {
  const templates = buildEmailTemplates({ businessName: "Acme", sendingDomain: hostile });
  for (const template of templates) {
    assert.ok(!template.html.includes("<script") && !template.html.includes(`" onmouseover`) && !template.html.includes("javascript:"), `${template.id} html is safe for ${hostile}`);
    assert.ok(!template.textBody.includes("<script") && !template.textBody.includes("javascript:") && !template.textBody.includes(`"`), `${template.id} text has no hostile link for ${hostile}`);
  }
}

// 5. Site-wide security headers from next.config.ts, applied the way vinext applies config headers.
const nextConfig = load("next.config.ts").default;
assert.equal(typeof nextConfig.headers, "function", "next.config.ts defines headers()");
const rules = await nextConfig.headers();
const expected = {
  "x-frame-options": "DENY",
  "content-security-policy": "frame-ancestors 'none'; object-src 'none'; base-uri 'self'; form-action 'self'",
  "referrer-policy": "strict-origin-when-cross-origin",
  "x-content-type-options": "nosniff",
  "permissions-policy": "camera=(self), microphone=(self), geolocation=(self)",
};
const ctx = { headers: new Headers(), cookies: {}, query: new URLSearchParams(), host: "crm.example.com" };
for (const pathname of ["/", "/api/export", "/api/documents", "/proposal/abc123", "/portal", "/portal/x/y", "/unsubscribe"]) {
  const applied = new Headers();
  applyConfigHeadersToResponse(applied, { pathname, configHeaders: rules, requestContext: ctx });
  for (const [name, value] of Object.entries(expected)) assert.equal(applied.get(name), value, `${name} is set on ${pathname}`);
  assert.ok(!/script-src|default-src/.test(applied.get("content-security-policy")), "global CSP does not restrict scripts");
}
assert.ok(matchHeaders("/", rules, ctx).length > 0, "root path matches");
// Document downloads keep their stricter CSP: vinext never overwrites a header the route already set.
const documentHeaders = new Headers({ "content-security-policy": "default-src 'none'; sandbox" });
applyConfigHeadersToResponse(documentHeaders, { pathname: "/api/documents", configHeaders: rules, requestContext: ctx });
assert.equal(documentHeaders.get("content-security-policy"), "default-src 'none'; sandbox", "route-level CSP wins over the global one");
assert.equal(documentHeaders.get("x-frame-options"), "DENY");

console.log("output hardening tests passed");
