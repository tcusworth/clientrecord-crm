# Simplify ClientRecord (one pipeline, one Deals screen, short menu) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the CSI pipeline the only pipeline everywhere, merge the Deals and Pipelines screens into one Deals screen that shows every deal, delete the leftover "Test" deal, and reorganise the menu into Main / More / Admin.

**Architecture:** A single `mainPipeline(db)` helper in `lib/services/deals.ts` becomes the source of truth for "the pipeline"; `pipelines(db)` stops adding the built-in "New business" pipeline once any pipeline is saved. Every deal-creating path uses the helper. A data-only D1 migration deletes the Test deal and its dependent rows. The Deals screen (`components/deal-workspace.tsx`) uses the main pipeline, gains an "Other" column and an admin-only "Configure stages" dialog (stage editor moved to its own component). `app/page.tsx` nav is regrouped; `pipelines` is removed and `?view=pipelines` maps to Deals.

**Tech Stack:** vinext (Next.js App Router on Vite), React, TypeScript, Cloudflare Worker + D1, node test scripts (`scripts/test-*.mjs` via `scripts/test-helpers.mjs`), pnpm.

**Spec:** `docs/superpowers/specs/2026-10-07-simplify-ui-design.md`

## Global Constraints

- CSI (`sales_pipelines.id = 'csi'`) is the only pipeline in production; the built-in `defaultPipeline` ("New business") is used ONLY when no pipeline is saved (fresh installs).
- Main pipeline = first saved pipeline in `sales_pipelines` ordered by `rowid`.
- Delete exactly the deal(s) with `pipeline_key='default' AND name='Test'` (production: one deal, id 1, with 9 `deal_stage_history` rows and no other dependents) plus every dependent row; touch nothing else.
- Nothing is deleted from the UI or codebase except the Pipelines menu item and the "New pipeline" button; every other screen keeps working.
- Menu: Main = Today, Deals, Companies, Contacts, Lead capture, Proposals, Customer success, Documents, Activity, Service cases, Sales analytics (flat, no header). More (collapsed) = Dashboard, Inbox, Communication review, Campaigns, Audiences, Automations, Partners, Competitive intel, Field capture. Admin (owners/admins only) = Integrations, Operations, Settings, Cleanup, Custom objects, AI governance.
- Existing nav item ids are unchanged (favorites, `?view=`, `clientrecord:last-workspace` keep working); `?view=pipelines` and a remembered `pipelines` open Deals.
- Commits end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`; gitleaks hook must pass; never push/deploy/`--remote`.
- Every task ends with `pnpm test`, `pnpm typecheck`, `pnpm lint` (0 errors) passing.

---

## File structure

| Path | Responsibility |
|---|---|
| `lib/services/deals.ts` (modify) | `pipelines()` rule change; new `mainPipeline()` |
| `app/api/quick-capture/route.ts`, `app/api/v1/records/route.ts`, `lib/customer-success.ts`, `app/api/deal-workspace/route.ts`, `mcp/src/tools.ts` (modify) | Use `mainPipeline()` when creating deals / resolving stages |
| `app/api/sales/route.ts` (modify) | GET returns `mainPipelineId` |
| `drizzle/0030_remove_test_deal.sql` + `drizzle/meta/_journal.json` + `drizzle/meta/0030_snapshot.json` (create/modify) | Data-only deletion of the Test deal and dependents |
| `components/pipeline-editor.tsx` (create) | Stage editor moved out of sales-foundation.tsx (avoids a circular import) |
| `components/sales-foundation.tsx` (modify) | Import `PipelineEditor` from the new file; Pipelines screen no longer reachable from the menu |
| `components/deal-workspace.tsx` (modify) | Main pipeline, "Other" column, "Configure stages" |
| `app/page.tsx` (modify) | Nav regrouping, `pipelines` → `deals` redirect |
| `scripts/test-main-pipeline.mjs`, `scripts/test-remove-test-deal.mjs`, `scripts/test-nav.mjs` (create) | Tests |

---

### Task 1: Main pipeline rule and every deal-creating path

**Files:**
- Modify: `lib/services/deals.ts:11-15`
- Modify: `app/api/quick-capture/route.ts:16`, `app/api/v1/records/route.ts` (deals branch of POST), `lib/customer-success.ts:24-25`, `app/api/deal-workspace/route.ts:41-43`, `mcp/src/tools.ts` (`create_deal` default pipeline), `app/api/sales/route.ts` (GET payload)
- Test: `scripts/test-main-pipeline.mjs`

**Interfaces:**
- Produces: `export async function mainPipeline(db: D1Database): Promise<Pipeline>` in `lib/services/deals.ts`; `pipelines(db)` returns saved pipelines in `rowid` order, or `[defaultPipeline]` when none are saved. `GET /api/sales` adds `mainPipelineId: string`.

- [ ] **Step 1: Write the failing test `scripts/test-main-pipeline.mjs`**

```js
import assert from "node:assert/strict";
import { createTestContext } from "./test-helpers.mjs";

const { sqlite, env, load } = createTestContext();
const deals = load("lib/services/deals.ts");
const fresh = await deals.mainPipeline(env.DB);
assert.equal(fresh.id, "default", "fresh install falls back to the built-in pipeline");
assert.deepEqual((await deals.pipelines(env.DB)).map(p => p.id), ["default"]);

const stages = JSON.stringify([{ key: "target", name: "Target", probability: 10, kind: "Open" }, { key: "won", name: "Won", probability: 100, kind: "Won" }, { key: "lost", name: "Lost", probability: 0, kind: "Lost" }]);
sqlite.prepare("INSERT INTO sales_pipelines(id,name,stages,updated_at) VALUES ('csi','CSI pipeline',?, 'now')").run(stages);
sqlite.prepare("INSERT INTO sales_pipelines(id,name,stages,updated_at) VALUES ('aaa','AAA later',?, 'now')").run(stages);
assert.equal((await deals.mainPipeline(env.DB)).id, "csi", "first saved by rowid, not by name");
assert.deepEqual((await deals.pipelines(env.DB)).map(p => p.id), ["csi", "aaa"], "built-in no longer prepended once pipelines are saved");

// customer success renewal lands in the main pipeline at its first Open stage
// (seed the minimum plan row the renewal function needs; read lib/customer-success.ts for the exact function name/arguments and table columns)
console.log("PASS: main pipeline rule");
```
Extend the test (same file) with: a renewal created via the customer-success function has `pipeline_key='csi'`, `stage_key='target'`; a deal created via the v1 records POST handler (load `app/api/v1/records/route.ts` and call `POST` with a `records.write` API key the way `scripts/test-security.mjs` or another existing test does) without a pipeline gets `pipeline_key='csi'`; a quick-capture deal gets `pipeline_key='csi'` (follow how existing tests call `app/api/quick-capture/route.ts`). Use the real exported names you find; adjust seeds to the schema.

- [ ] **Step 2: Run it — expect FAIL (`mainPipeline is not a function`)**

Run: `node scripts/test-main-pipeline.mjs`

- [ ] **Step 3: Implement the rule in `lib/services/deals.ts`**

```ts
export async function pipelines(db: D1Database): Promise<Pipeline[]> {
  const saved = (await db.prepare("SELECT * FROM sales_pipelines ORDER BY rowid").all<Row>()).results;
  const list = saved.map(r => ({ id: String(r.id), name: String(r.name), stages: JSON.parse(String(r.stages)) }));
  return list.length ? list : [defaultPipeline];
}

// The single pipeline this install works in: the first saved one, or the built-in pipeline on a fresh install.
export async function mainPipeline(db: D1Database): Promise<Pipeline> {
  return (await pipelines(db))[0];
}
```
Check every caller of `pipelines()` (`grep -rn "pipelines(" app lib mcp components`) still works when the built-in pipeline is absent — e.g. code doing `.find(p => p.id === "default")` or `saveDeal` validating `pipeline_key` against `pipelines(db)`: an existing deal with `pipeline_key='default'` saved after this change must not become unsaveable; if `saveDeal` would reject it, make `saveDeal` resolve the built-in pipeline for `pipeline_key='default'` (`p.id === 'default' ? defaultPipeline`) so legacy rows still save.

- [ ] **Step 4: Switch each deal-creating path to `mainPipeline()`**
- `app/api/quick-capture/route.ts` deal branch: replace the inline `SELECT * FROM sales_pipelines ORDER BY rowid LIMIT 1` + `defaultPipeline` fallback with `const pipeline = await mainPipeline(env.DB)` and use `pipeline.id` / `pipeline.stages[0]` (keep the same first-stage behaviour it has today).
- `app/api/v1/records/route.ts` deals branch: when the body has no `pipelineKey`/`pipeline_key`, use `mainPipeline()` and its first Open stage instead of `'default'`.
- `lib/customer-success.ts` renewal: create the deal with `pipeline_key = main.id`, `stage_key`/`stage` = the main pipeline's first Open stage key/name, probability = that stage's probability; remove the `INSERT OR IGNORE INTO sales_pipelines ... 'renewals'` statement. Name, next step, value and the rest unchanged.
- `app/api/deal-workspace/route.ts` `coverageStage`: when the deal's pipeline isn't saved, fall back to `(await mainPipeline(env.DB)).stages` instead of `defaultPipeline.stages` only for `'default'`.
- `mcp/src/tools.ts` `create_deal`: replace its inline first-saved-pipeline query with `mainPipeline(ctx.db)` (behaviour identical).
- `app/api/sales/route.ts` GET: add `mainPipelineId: (await mainPipeline(db())).id` to the JSON payload.

- [ ] **Step 5: Run the new test and the full suite**

Run: `node scripts/test-main-pipeline.mjs && pnpm test && pnpm typecheck && pnpm lint`
Expected: PASS; all suites pass (update an existing test's expectation only where it asserted the built-in pipeline is listed alongside saved ones — list each such change in the commit message).

- [ ] **Step 6: Commit**

```bash
git add lib/services/deals.ts app/api/quick-capture/route.ts app/api/v1/records/route.ts lib/customer-success.ts app/api/deal-workspace/route.ts mcp/src/tools.ts app/api/sales/route.ts scripts/test-main-pipeline.mjs
git commit -m "feat: one main pipeline for every deal-creating path

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 2: Migration — delete the Test deal and its dependents

**Files:**
- Create: `drizzle/0030_remove_test_deal.sql`; modify `drizzle/meta/_journal.json`; create `drizzle/meta/0030_snapshot.json` (copy of 0029's with new id/prevId — follow exactly what 0029 did)
- Test: `scripts/test-remove-test-deal.mjs`

**Interfaces:** none consumed/produced beyond the data change.

- [ ] **Step 1: List every table with a column referencing deals**

Run: `cat drizzle/*.sql | grep -nE "deal_id|renewal_deal_id"` and the custom-field values table (`custom_field_values` with `entity_type='deal'`). Production has these deal-referencing tables: sync_records, deal_stage_history, deal_tasks, client_documents, deal_activities, deal_insights, deal_line_items, deal_notes, deal_proposals, deal_reviews, deal_stakeholders, deal_relationship_health_scores, deal_recommendations, deal_meetings, meetily_webhook_events, inbox_messages, customer_success_plans (renewal_deal_id), quickbooks_invoices, deal_competitors, partner_payouts, partner_referrals, service_cases, communication_review_items. Confirm each table's exact column name. Child-of-child rows (e.g. proposal acceptances/share events keyed by proposal_id, meeting attendees keyed by meeting_id, document_versions keyed by document_id) must be deleted before their parents.

- [ ] **Step 2: Write the failing test `scripts/test-remove-test-deal.mjs`**

The harness applies all `drizzle/*.sql` migrations when it builds the test DB, so the test seeds data and then re-runs the 0030 SQL file directly:
```js
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createTestContext } from "./test-helpers.mjs";

const { sqlite } = createTestContext();
const sql = readFileSync(new URL("../drizzle/0030_remove_test_deal.sql", import.meta.url), "utf8").replaceAll("--> statement-breakpoint", "");
sqlite.exec(`INSERT INTO deals(id,name,pipeline_key,stage,stage_key,owner,status,created_at,updated_at) VALUES
 (1,'Test','default','Qualified','Qualified','o','Open','now','now'),
 (2,'Test','csi','Target','target','o','Open','now','now'),
 (3,'Real','csi','Target','target','o','Open','now','now');
INSERT INTO deal_stage_history(deal_id,from_stage,to_stage,from_pipeline,to_pipeline,reason,actor,happened_at) VALUES (1,'a','b','','default','','o','now'),(3,'a','b','','csi','','o','now');
INSERT INTO deal_notes(deal_id,kind,body,owner,pinned,created_at,updated_at) VALUES (1,'Note','x','o',0,'now','now'),(3,'Note','y','o',0,'now','now');`);
sqlite.exec(sql);
assert.equal(sqlite.prepare("SELECT count(*) n FROM deals WHERE id=1").get().n, 0, "Test deal in default pipeline deleted");
assert.equal(sqlite.prepare("SELECT count(*) n FROM deals WHERE id IN (2,3)").get().n, 2, "CSI deals untouched, even one named Test");
assert.equal(sqlite.prepare("SELECT count(*) n FROM deal_stage_history WHERE deal_id=1").get().n, 0);
assert.equal(sqlite.prepare("SELECT count(*) n FROM deal_stage_history WHERE deal_id=3").get().n, 1);
assert.equal(sqlite.prepare("SELECT count(*) n FROM deal_notes WHERE deal_id=3").get().n, 1);
sqlite.exec(sql); // idempotent
assert.equal(sqlite.prepare("SELECT count(*) n FROM deals").get().n, 2);
assert.equal(sqlite.prepare("PRAGMA foreign_key_check").all().length, 0, "no orphaned foreign keys");
console.log("PASS: Test deal removal");
```
Adjust seed columns to the schema. Add seeds for at least one more dependent table (e.g. `deal_tasks`) to prove dependents go.

- [ ] **Step 3: Run it — expect FAIL (file not found)**

Run: `node scripts/test-remove-test-deal.mjs`

- [ ] **Step 4: Write `drizzle/0030_remove_test_deal.sql`**

Pattern (repeat the dependent DELETE for every table found in Step 1, grandchildren first, using each table's real column name; `--> statement-breakpoint` between statements as the existing migrations do):
```sql
-- Data-only: remove the leftover "Test" deal from the retired built-in pipeline, with everything attached to it.
DELETE FROM deal_stage_history WHERE deal_id IN (SELECT id FROM deals WHERE pipeline_key='default' AND name='Test');
--> statement-breakpoint
DELETE FROM deal_notes WHERE deal_id IN (SELECT id FROM deals WHERE pipeline_key='default' AND name='Test');
--> statement-breakpoint
UPDATE customer_success_plans SET renewal_deal_id=NULL WHERE renewal_deal_id IN (SELECT id FROM deals WHERE pipeline_key='default' AND name='Test');
--> statement-breakpoint
DELETE FROM custom_field_values WHERE entity_type='deal' AND entity_id IN (SELECT id FROM deals WHERE pipeline_key='default' AND name='Test');
--> statement-breakpoint
DELETE FROM deals WHERE pipeline_key='default' AND name='Test';
```
No `BEGIN`/`COMMIT`. Add the journal entry and snapshot exactly like 0029.

- [ ] **Step 5: Run the test, apply locally twice, full suite**

Run: `node scripts/test-remove-test-deal.mjs && pnpm db:migrate:local && pnpm db:migrate:local && pnpm test && pnpm typecheck && pnpm lint`
Expected: PASS; second migrate is a no-op.

- [ ] **Step 6: Commit**

```bash
git add drizzle/0030_remove_test_deal.sql drizzle/meta/_journal.json drizzle/meta/0030_snapshot.json scripts/test-remove-test-deal.mjs
git commit -m "feat(db): remove the leftover Test deal from the retired built-in pipeline

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 3: One Deals screen

**Files:**
- Create: `components/pipeline-editor.tsx` (move `PipelineEditor` and any helpers only it uses out of `components/sales-foundation.tsx`)
- Modify: `components/sales-foundation.tsx` (import `PipelineEditor` from the new file), `components/deal-workspace.tsx`
- Test: extend an existing UI-free test only if logic is extracted; otherwise verified by build + manual smoke (below)

**Interfaces:**
- Consumes: `GET /api/sales` → `{ deals, pipelines, mainPipelineId, user, ... }` (Task 1).
- Produces: `export function PipelineEditor({pipeline, disabled, run, close}: {pipeline?: Pipeline; disabled: boolean; run: Run; close: () => void})` in `components/pipeline-editor.tsx` (same props as today).

- [ ] **Step 1: Move `PipelineEditor`** to `components/pipeline-editor.tsx` unchanged (export it; move its private helpers/types with it or import shared types from where they live). `sales-foundation.tsx` imports it. Run `pnpm typecheck && pnpm build` — must pass with no behaviour change.

- [ ] **Step 2: Deals screen uses the main pipeline** — in `components/deal-workspace.tsx` replace
```ts
const pipeline=data?.pipelines[0]
```
with
```ts
const pipeline=data?(data.pipelines.find(p=>p.id===data.mainPipelineId)||data.pipelines[0]):undefined
```
and add `mainPipelineId:string` to its `Data` type.

- [ ] **Step 3: "Other" column** — deals whose `pipeline_key !== pipeline.id` or whose `stage_key||stage` matches no stage of the main pipeline are collected as `others`; when `others.length>0`, the board renders one extra column titled "Other" after the stage columns listing those cards (same card component, not draggable into/out of — dragging an Other card onto a stage column is allowed and saves it into that stage of the main pipeline). The table view already lists all visible deals; make sure its stage cell shows the deal's stored `stage` text for such deals.

- [ ] **Step 4: "Configure stages" button** — in the Deals header, for `data.user.role` owner/admin, add an outline button "Configure stages" opening a dialog (reuse the same `Dialog` component pattern used in `sales-foundation.tsx`, or the workspace's `RecordDrawer` if a Dialog isn't exported — move `Dialog` into a shared file only if needed) with `<PipelineEditor pipeline={pipeline} disabled={busy} run={run} close={...}/>`. `run` posts `{action, ...payload}` to `/api/sales` like `save` does, then reloads. Rename the header title from "Deals and forecast" only if it mentions pipelines — keep "Deals and forecast".

- [ ] **Step 5: Verify**
Run: `pnpm test && pnpm typecheck && pnpm lint && pnpm build`. Smoke: `pnpm db:migrate:local`, seed a local `csi` pipeline + 2 deals (one in a CSI stage, one with an unknown stage) via `pnpm exec wrangler d1 execute DB --local --config wrangler.jsonc --command "..."`, `pnpm dev`, then in the browser (or `curl` for 200 plus the dev log for errors) confirm the board shows CSI columns, the unknown-stage deal under "Other", and Configure stages opens for the owner. Stop the dev server.

- [ ] **Step 6: Commit**

```bash
git add components/pipeline-editor.tsx components/sales-foundation.tsx components/deal-workspace.tsx
git commit -m "feat: one Deals screen on the main pipeline with an Other column and stage settings

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 4: Short menu

**Files:**
- Modify: `app/page.tsx:53-60` (`navGroups`), `:107` (view restore), `:119` (`visibleNavGroups`), `:160` (nav rendering), `:165` (pipelines section)
- Test: `scripts/test-nav.mjs`

**Interfaces:**
- Produces: `export const navGroups` structure `{id:"main"|"more"|"admin", label:string, items:{id,label,icon}[]}[]` moved to `lib/navigation.ts` (plain data + a pure `resolveSection(id: string|null): string|null` that maps `"pipelines"`→`"deals"` and returns null for unknown ids), so it can be unit-tested; `app/page.tsx` imports it. Icons stay in page.tsx: `lib/navigation.ts` holds ids/labels/groups only; page.tsx maps id → icon.

- [ ] **Step 1: Write the failing test `scripts/test-nav.mjs`**

```js
import assert from "node:assert/strict";
import { createTestContext } from "./test-helpers.mjs";

const { load } = createTestContext();
const nav = load("lib/navigation.ts");
const ids = g => nav.navGroups.find(x => x.id === g).items.map(i => i.id);
assert.deepEqual(ids("main"), ["today","deals","companies","contacts","leads","proposals","customers","documents","activities","service","reports"]);
assert.deepEqual(ids("more"), ["dashboard","inbox","communication-review","campaigns","audiences","automations","partners","competitive","field"]);
assert.deepEqual(ids("admin"), ["integrations","operations","settings","cleanup","custom-objects","ai-governance"]);
assert.ok(!nav.navGroups.some(g => g.items.some(i => i.id === "pipelines")), "Pipelines removed from the menu");
assert.equal(nav.resolveSection("pipelines"), "deals");
assert.equal(nav.resolveSection("campaigns"), "campaigns");
assert.equal(nav.resolveSection("nope"), null);
console.log("PASS: navigation");
```

- [ ] **Step 2: Run it — expect FAIL (module missing)**

Run: `node scripts/test-nav.mjs`

- [ ] **Step 3: Create `lib/navigation.ts`**

```ts
export type NavItem = { id: string; label: string };
export type NavGroup = { id: "main" | "more" | "admin"; label: string; items: NavItem[] };

export const navGroups: NavGroup[] = [
  { id: "main", label: "", items: [{ id: "today", label: "Today" }, { id: "deals", label: "Deals" }, { id: "companies", label: "Companies" }, { id: "contacts", label: "Contacts" }, { id: "leads", label: "Lead capture" }, { id: "proposals", label: "Proposals" }, { id: "customers", label: "Customer success" }, { id: "documents", label: "Documents" }, { id: "activities", label: "Activity" }, { id: "service", label: "Service cases" }, { id: "reports", label: "Sales analytics" }] },
  { id: "more", label: "More", items: [{ id: "dashboard", label: "Dashboard" }, { id: "inbox", label: "Inbox" }, { id: "communication-review", label: "Communication review" }, { id: "campaigns", label: "Campaigns" }, { id: "audiences", label: "Audiences" }, { id: "automations", label: "Automations" }, { id: "partners", label: "Partners" }, { id: "competitive", label: "Competitive intel" }, { id: "field", label: "Field capture" }] },
  { id: "admin", label: "Admin", items: [{ id: "integrations", label: "Integrations" }, { id: "operations", label: "Operations" }, { id: "settings", label: "Settings" }, { id: "cleanup", label: "Cleanup" }, { id: "custom-objects", label: "Custom objects" }, { id: "ai-governance", label: "AI Governance" }] },
];

const ALIASES: Record<string, string> = { pipelines: "deals" };
const ALL = new Set(navGroups.flatMap(g => g.items.map(i => i.id)));
export function resolveSection(id: string | null): string | null {
  if (!id) return null;
  const target = ALIASES[id] ?? id;
  return ALL.has(target) ? target : null;
}
```

- [ ] **Step 4: Wire `app/page.tsx`**
- Replace the inline `navGroups` with an import from `@/lib/navigation` plus a `const navIcons: Record<string, LucideIcon> = { today: CalendarClock, deals: Briefcase, ... }` built from the icons already used (keep each item's current icon); derive `nav` as before (`navGroups.flatMap(...)` with icons attached).
- `visibleNavGroups`: owners/admins see all three groups; others don't see `admin` (replaces `group.id!=="platform"`).
- Rendering (line ~160): render the `main` group as a flat list (no collapsible header); `more` and `admin` as the existing `Collapsible` groups. `more` is closed by default unless the active section is inside it (existing `open=active||openNavGroups[id]` logic already does this).
- View restore (line ~107): use `resolveSection(view)` and `resolveSection(remembered)` so `?view=pipelines` and a remembered `pipelines` open Deals.
- Remove the `section==="pipelines"&&<SalesFoundation section="pipelines"/>` render line; keep `SalesFoundation`'s `pipelines` support only if another caller uses it — otherwise narrow its `section` type to `"companies"|"deals"` and drop the dead branch (the PipelineEditor now lives in its own file). Remove imports this makes unused (e.g. `Columns3`).
- Check the command palette / search (grep `nav.` / `nav.find` / `nav.some` in page.tsx) still lists every screen.

- [ ] **Step 5: Verify**
Run: `node scripts/test-nav.mjs && pnpm test && pnpm typecheck && pnpm lint && pnpm build`. Smoke with `pnpm dev`: the sidebar shows the flat main list, collapsed More, Admin for the owner; `http://localhost:3000/?view=pipelines` opens Deals; stop the server.

- [ ] **Step 6: Commit**

```bash
git add lib/navigation.ts app/page.tsx components/sales-foundation.tsx scripts/test-nav.mjs
git commit -m "feat: short main menu with More and Admin sections; Pipelines folded into Deals

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 5: Docs and final verification

**Files:** Modify `README.md` (wherever it describes pipelines/navigation; add one short "Navigation" note: main menu, More, Admin; CSI is the single pipeline; "Configure stages" on Deals).

- [ ] **Step 1: Update README** (only sentences that are now wrong + the short note).
- [ ] **Step 2: Full verification** — `pnpm test && pnpm typecheck && pnpm lint && pnpm build`; `pnpm --filter clientrecord-mcp typecheck`; local MCP e2e (`mcp/.dev.vars` with `DEV_AUTHORIZE_AS=tcusworth@gmail.com`, `pnpm --filter clientrecord-mcp dev` in background, `node mcp/scripts/e2e.mjs`, stop it). No dev servers left running.
- [ ] **Step 3: Commit**

```bash
git add README.md
git commit -m "docs: navigation and single-pipeline notes

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```
