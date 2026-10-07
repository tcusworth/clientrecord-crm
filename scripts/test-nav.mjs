import assert from "node:assert/strict";
import { createTestContext } from "./test-helpers.mjs";

const { load } = createTestContext();
const nav = load("lib/navigation.ts");
const ids = g => nav.navGroups.find(x => x.id === g).items.map(i => i.id);
assert.deepEqual(ids("main"), ["today","deals","companies","contacts","leads","proposals","customers","documents","activities","service","reports"]);
assert.deepEqual(ids("more"), ["connections","dashboard","inbox","communication-review","campaigns","audiences","automations","partners","competitive","field"]);
assert.deepEqual(ids("admin"), ["integrations","operations","settings","cleanup","custom-objects","ai-governance"]);
assert.ok(!nav.navGroups.some(g => g.items.some(i => i.id === "pipelines")), "Pipelines removed from the menu");
assert.equal(nav.resolveSection("pipelines"), "deals");
assert.equal(nav.resolveSection("campaigns"), "campaigns");
assert.equal(nav.resolveSection("nope"), null);
console.log("PASS: navigation");
