# Simplify ClientRecord for a single business — design

**Status:** Approved in conversation 2026-10-07 · **Owner:** tcusworth@gmail.com

## Problem

ClientRecord is used by one business (Collaborative Systems Integration, two people) but ships a general-purpose UI: 27 menu screens in 7 groups, and two pipelines. The Deals screen always uses the first pipeline in the list — the built-in "New business" pipeline holding only a "Test" deal — so the 15 CSI deals (pipeline `csi`, stages Target…Won/Lost) fall into no board column and are effectively invisible. The Pipelines screen shows them only after picking CSI from a dropdown that resets to "New business" on every visit. Deals and Pipelines are near-duplicate boards.

## Decisions (owner)

| Topic | Decision |
|---|---|
| Pipelines | CSI is the **only** pipeline. Retire the built-in "New business" pipeline. |
| "Test" deal | **Delete** it (the only deal in the built-in pipeline). |
| Deals vs Pipelines | Merge into one **Deals** screen; no pipeline dropdown. Stage editing moves to a "Configure stages" button on Deals (owners/admins only). |
| Menu | Short main menu + collapsed **More** section + **Admin** section. Nothing deleted. |

## Part 1 — one main pipeline

- **Main pipeline rule (single source of truth):** a helper `mainPipeline(db)` returns the first saved pipeline in `sales_pipelines` by rowid (today: `csi`); only when no pipeline is saved does it fall back to the built-in `defaultPipeline` (fresh installs keep working). `pipelines(db)` stops prepending the built-in pipeline when any saved pipeline exists.
- **Every place that creates or lists deals uses the main pipeline:**
  - Deals screen (components/deal-workspace.tsx: board columns, new-deal form, stage dropdowns) — replaces `data.pipelines[0]`.
  - Quick capture (app/api/quick-capture) — already first-saved-by-rowid; switch to the helper.
  - Records API (app/api/v1/records POST deals) — currently defaults to `default`; use the helper.
  - Customer success renewals (lib/customer-success.ts) — currently creates a separate `renewals` pipeline; instead create the renewal deal in the main pipeline at its first Open stage (name and next step unchanged). Existing renewal deals (if any) are left as-is.
  - Deal workspace stage lookup (app/api/deal-workspace ~L42) — fall back to the main pipeline rather than the built-in one.
  - MCP `create_deal` default — already first saved pipeline; switch to the helper.
- **Data migration (data-only, idempotent, runs on next deploy):** delete the "Test" deal — `pipeline_key='default' AND name='Test'` — and its dependent rows (stage history, notes, activities, tasks, stakeholders, line items, insights, reviews, custom field values, and any other table with a `deal_id` referencing it), so foreign keys stay valid. It must touch nothing else; if additional deals exist in `default`, they are left alone (the UI still lists every deal; see below).
- **Safety net:** any deal whose `pipeline_key` isn't the main pipeline, or whose stage isn't one of its stages, still appears in the Deals **table** view (and in a small "Other" column on the board) rather than disappearing.

## Part 2 — one Deals screen

- Remove the **Pipelines** menu item. The Deals screen (DealWorkspace) shows all deals: board (main pipeline's stages in order, Won/Lost last) and table, with existing views (All open, Mine, etc.).
- **Configure stages** button on Deals, owners/admins only, opens the existing pipeline stage editor for the main pipeline (reuse the Pipelines screen's configure dialog; "New pipeline" is removed from the UI).
- Old links: `?view=pipelines` opens Deals.

## Part 3 — short menu

| Main menu | More (collapsed by default) | Admin (owners/admins only, as today) |
|---|---|---|
| Today | Dashboard | Integrations |
| Deals | Inbox | Operations |
| Companies | Communication review | Settings |
| Contacts | Campaigns | Cleanup |
| Lead capture | Audiences | Custom objects |
| Proposals | Automations | AI governance |
| Customer success | Partners | |
| Documents | Competitive intel | |
| Activity | Field capture | |
| Service cases | | |
| Sales analytics | | |

- Main menu items have no group header (flat list); "More" and "Admin" are collapsible groups. Admin keeps today's role gating.
- Every screen keeps working exactly as before; only its menu position changes. Favorites, search/command palette and `?view=` links keep working for every screen, including ones under More.
- Today stays the landing screen.

## Out of scope

Redesigning individual screens, removing features or code, the stacked two-component pages (Inbox, Proposals, Sales analytics), and multi-business support.

## Testing

- Unit: `mainPipeline` (saved pipeline wins; built-in only when none saved); `pipelines()` no longer includes the built-in when saved ones exist; renewals land in the main pipeline; v1 records and quick capture default to it.
- Migration: on a test DB with a `default`/"Test" deal plus dependents and a CSI deal, the migration removes only the Test deal and its dependents, is idempotent, and leaves CSI data intact.
- UI: the Deals board renders CSI deals in CSI stage columns; a deal in an unknown stage appears under "Other"; the nav renders the three sections with the items above; `?view=pipelines` resolves to Deals. Existing test suite passes; lint 0 errors; build passes.
- Manual after deploy: Deals shows all 14 CSI open deals + Energy Transfer (Won); "New business" no longer appears anywhere.
