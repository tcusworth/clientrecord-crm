import assert from "node:assert/strict";
import { createTestContext } from "./test-helpers.mjs";

const { sqlite, load } = createTestContext();
sqlite.exec(`INSERT INTO team_members(email,name,role,permissions,active,created_at,updated_at) VALUES
 ('editor@example.com','Eddie','editor','{}',1,'now','now'),
 ('gone@example.com','Gone','editor','{}',0,'now','now'),
 ('custom@example.com','Cus','viewer','["records.view","records.edit"]',1,'now','now')`);
const { userByEmail, can } = load("lib/crm-auth.ts");

const owner = await userByEmail("Owner@Example.com");
assert.equal(owner.role, "owner"); assert.equal(owner.email, "owner@example.com");
const editor = await userByEmail("editor@example.com");
assert.equal(editor.role, "editor"); assert.equal(can(editor, "records.edit"), true); assert.equal(can(editor, "records.delete"), false);
assert.equal(await userByEmail("gone@example.com"), null, "inactive members are rejected");
assert.equal(await userByEmail("stranger@example.com"), null, "unknown emails are rejected");
assert.equal(await userByEmail(""), null);
const custom = await userByEmail("custom@example.com");
assert.deepEqual(custom.permissions, ["records.view", "records.edit"], "custom permissions win over role defaults");
assert.equal((await userByEmail("editor@example.com", "mcp:editor@example.com")).id, "mcp:editor@example.com");

const { rateLimitKey } = load("lib/rate-limit.ts");
for (let i = 0; i < 3; i++) assert.equal((await rateLimitKey("mcp:a@example.com", 3)).limited, false);
const over = await rateLimitKey("mcp:a@example.com", 3);
assert.equal(over.limited, true); assert.ok(over.retryAfter >= 1);
assert.equal((await rateLimitKey("mcp:b@example.com", 3)).limited, false, "keys are independent");
assert.equal((await rateLimitKey("mcp:c@example.com", 3, 60, 3)).limited, false, "a cost of 3 fits a limit of 3");
assert.equal((await rateLimitKey("mcp:c@example.com", 3, 60, 1)).limited, true, "cost counts toward the window");
assert.equal((await rateLimitKey("mcp:d@example.com", 3, 60, 4)).limited, true, "a single cost above the limit is limited");
console.log("PASS: userByEmail resolves owner/members/permissions and rejects inactive/unknown; rateLimitKey limits per key.");
