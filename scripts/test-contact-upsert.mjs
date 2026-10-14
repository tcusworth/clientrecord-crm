import assert from "node:assert/strict";
import { createTestContext } from "./test-helpers.mjs";

const { sqlite, load } = createTestContext();
const { parseUpsertInput } = load("lib/contact-upsert-input.ts");

// Schema
sqlite.prepare("INSERT INTO contact_lists(name,created_at) VALUES ('State of OPA 2026',datetime('now'))").run();
assert.throws(() => sqlite.prepare("INSERT INTO contact_lists(name,created_at) VALUES ('state of opa 2026',datetime('now'))").run(), /UNIQUE/);
sqlite.prepare("INSERT INTO form_submissions(id,submission_id,action,source,created_at) VALUES ('a','s1','created','decoder','now')").run();
assert.throws(() => sqlite.prepare("INSERT INTO form_submissions(id,submission_id,action,source,created_at) VALUES ('b','s1','created','decoder','now')").run(), /UNIQUE/);
sqlite.prepare("INSERT INTO form_submissions(id,action,source,created_at) VALUES ('c','created','decoder','now'),('d','created','decoder','now')").run(); // many NULL submission ids allowed

// Validator
const ok = parseUpsertInput({ email: "  Jane.Doe@X.com ", fullName: "Jane van Doe", source: "report_download", reportName: "State of OPA 2026", consent: "on", lists: ["State of OPA 2026", " state of opa 2026 ", "Insights"], utm: { source: "linkedin" } });
assert.equal(ok.ok, true);
assert.equal(ok.value.email, "jane.doe@x.com");
assert.deepEqual([ok.value.firstName, ok.value.lastName], ["Jane", "van Doe"]);
assert.equal(ok.value.consent, true);
assert.deepEqual(ok.value.lists, ["State of OPA 2026", "Insights"]);
assert.equal(ok.value.utm.source, "linkedin");
assert.equal(ok.value.utm.medium, "");
assert.deepEqual(parseUpsertInput({ email: "a@b.co", firstName: "Al", fullName: "Zed Q", source: "decoder" }).value.lastName, "Q", "fullName only fills the missing part");
for (const [value, expected] of [["true", true], ["yes", true], ["1", true], [false, false], ["off", false], ["no", false], ["0", false], [undefined, null]]) assert.equal(parseUpsertInput({ email: "a@b.co", source: "decoder", consent: value }).value.consent, expected, String(value));
const bad = body => parseUpsertInput(body);
assert.deepEqual(Object.keys(bad({ source: "decoder" }).fields), ["email"]);
assert.ok(bad({ email: "nope", source: "decoder" }).fields.email);
assert.ok(bad({ email: "a@b.co", source: "webinar" }).fields.source);
for (const source of ["constructor", "toString", "__proto__"]) assert.ok(bad({ email: "a@b.co", source }).fields?.source, `source ${source} rejected`);
assert.ok(bad({ email: "a@b.co", source: "report_download" }).fields.reportName);
assert.ok(bad({ email: "a@b.co", source: "decoder", consent: "maybe" }).fields.consent);
assert.ok(bad({ email: "a@b.co", source: "decoder", lists: Array.from({ length: 11 }, (_, i) => `L${i}`) }).fields.lists);
assert.ok(bad({ email: "a@b.co", source: "decoder", lists: "State" }).fields.lists);
assert.ok(bad({ email: "a@b.co", source: "decoder", jobTitle: "x".repeat(201) }).fields.jobTitle);
assert.ok(bad({ email: "a@b.co", source: "decoder", note: { body: "x".repeat(10001) } }).fields["note.body"]);
for (const body of [null, [], "text", 42]) assert.equal(parseUpsertInput(body).ok, false);
console.log("contact upsert: schema + validator ok");
