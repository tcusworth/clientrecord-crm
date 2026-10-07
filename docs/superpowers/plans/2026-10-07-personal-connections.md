# Personal Microsoft and Google Connections Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let each ClientRecord user connect their own Microsoft 365 / Google mailbox and calendar, synced automatically and on demand, with owners/admins able to see and disconnect anyone's connection.

**Architecture:** `integration_accounts` gains `user_email` (unique per provider+user; `''` = company-wide for QuickBooks) plus `status`; Google/Microsoft OAuth callbacks store the connection under the user who started it. The existing per-provider sync bodies move into `lib/integrations/{microsoft,google}-sync.ts` as `syncMicrosoftAccount(account)` / `syncGoogleAccount(account)` that run as the account's owner; `lib/integrations/sync-all.ts` syncs every account (hourly cron + daily maintenance). A new "Email & calendar" screen (More menu) manages own and team connections.

**Tech Stack:** vinext (Next.js App Router on Vite), React, TypeScript, Cloudflare Worker + D1, node test scripts (`scripts/test-*.mjs` via `scripts/test-helpers.mjs`), pnpm.

**Spec:** `docs/superpowers/specs/2026-10-07-personal-connections-design.md`

## Global Constraints

- Who sees synced mail: everyone sees CRM-matched email/meetings, each labelled with whose mailbox it came from (`owner` = mailbox owner's CRM email).
- Connect / Sync now / preferences / disconnect OWN Google or Microsoft account: any user with `records.edit`. See all + disconnect ANY: `integrations.manage`. Viewers cannot connect. QuickBooks unchanged (company-wide, `integrations.manage`).
- Sync windows, matching, dedupe and read-only scopes unchanged; dedupe stays global (shared emails stored once, labelled with whoever synced first).
- Automatic sync: every Google/Microsoft account, from the hourly scheduled run and from daily maintenance; per-account 50-minute guard; one account's failure never stops others; token failures set `status='needs_reconnect'`.
- Tokens stay encrypted (`encryptToken`/`decryptToken`, `CRM_TOKEN_ENCRYPTION_KEY`) and are never returned to the browser.
- Audit entries for connect, disconnect (incl. who disconnected whose account), preferences, and sync runs.
- Production has no connected Google/Microsoft accounts today.
- Commits end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`; gitleaks hook must pass; never push/deploy/`--remote`.
- Every task ends with `pnpm test`, `pnpm typecheck`, `pnpm lint` (0 errors) passing; UI tasks also `pnpm build`.

---

## File structure

| Path | Responsibility |
|---|---|
| `drizzle/0031_personal_connections.sql` (+ journal, snapshot) | Add `user_email`, `status` to `integration_accounts`; unique `(provider,user_email)`; add `account_id` to `inbox_messages`, `sync_records` |
| `db/schema.ts` | Match the migration |
| `lib/integrations/accounts.ts` (create) | Account lookup/permission helpers |
| `lib/integrations/microsoft-sync.ts`, `lib/integrations/google-sync.ts` (create) | Per-account sync, extracted from the sync routes |
| `lib/integrations/sync-all.ts` (create) | `syncAllAccounts()` |
| `app/api/{microsoft,google}/{connect,callback,sync}/route.ts` (modify) | Per-user connect/callback; Sync now own account |
| `app/api/integrations/route.ts` (modify) | List own/team accounts, preferences, disconnect own/any |
| `app/api/advanced/route.ts` (modify) | Remove single-account assumption |
| `lib/scheduled-jobs.ts`, `lib/operations.ts` (modify) | Call `syncAllAccounts` |
| `components/email-calendar.tsx` (create), `lib/navigation.ts`, `app/page.tsx`, `components/production-workspace.tsx` (modify) | New screen + menu entry; old panel points to it |
| Inbox / activity UI (modify) | "from <person>'s mailbox" label |
| `scripts/test-personal-connections.mjs` (create) | Tests |

---

### Task 1: Schema — per-user connections

**Files:** Create `drizzle/0031_personal_connections.sql`; modify `drizzle/meta/_journal.json`, create `drizzle/meta/0031_snapshot.json` (generate with the repo's drizzle-kit command `pnpm db:generate` after editing `db/schema.ts`, then hand-check the SQL; if generation would also emit unrelated diffs, hand-write the SQL and copy the snapshot convention from 0029/0030 but with the schema changes reflected); modify `db/schema.ts:175`; test `scripts/test-personal-connections.mjs`.

**Interfaces — Produces:** columns `integration_accounts.user_email TEXT NOT NULL DEFAULT ''`, `integration_accounts.status TEXT NOT NULL DEFAULT 'connected'` (`'connected'|'needs_reconnect'`), unique index `integration_accounts_provider_user_unique` on `(provider,user_email)` (the old `integration_accounts_provider_unique` dropped); `inbox_messages.account_id INTEGER` and `sync_records.account_id INTEGER` (nullable).

- [ ] **Step 1: Failing test** (`scripts/test-personal-connections.mjs`):
```js
import assert from "node:assert/strict";
import { createTestContext } from "./test-helpers.mjs";
const { sqlite } = createTestContext();
const ins = (p, u) => sqlite.prepare("INSERT INTO integration_accounts(provider,user_email,account_email,access_token,refresh_token,expires_at,created_at,updated_at) VALUES (?,?,?,'a','r','2099-01-01','now','now')").run(p, u, u || "co@x.com");
ins("microsoft", "a@x.com"); ins("microsoft", "b@x.com"); ins("quickbooks", "");
assert.throws(() => ins("microsoft", "a@x.com"), /UNIQUE/);
assert.throws(() => ins("quickbooks", ""), /UNIQUE/);
assert.equal(sqlite.prepare("SELECT status FROM integration_accounts WHERE user_email='a@x.com'").get().status, "connected");
sqlite.prepare("INSERT INTO sync_records(provider,external_id,account_id,created_at) VALUES ('microsoft','m1',1,'now')").run();
console.log("PASS: personal connections schema");
```
(Adjust the sync_records insert columns to its real NOT NULL columns.)
- [ ] **Step 2:** `node scripts/test-personal-connections.mjs` → FAIL (no column user_email).
- [ ] **Step 3:** Write the migration (SQLite can't drop a UNIQUE constraint defined as an index — it is `CREATE UNIQUE INDEX integration_accounts_provider_unique`, so `DROP INDEX` works):
```sql
ALTER TABLE `integration_accounts` ADD `user_email` text DEFAULT '' NOT NULL;
--> statement-breakpoint
ALTER TABLE `integration_accounts` ADD `status` text DEFAULT 'connected' NOT NULL;
--> statement-breakpoint
DROP INDEX IF EXISTS `integration_accounts_provider_unique`;
--> statement-breakpoint
CREATE UNIQUE INDEX `integration_accounts_provider_user_unique` ON `integration_accounts` (`provider`,`user_email`);
--> statement-breakpoint
UPDATE `integration_accounts` SET `user_email`='trevor.cusworth@csi-automation.com' WHERE `provider` IN ('google','microsoft') AND `user_email`='';
--> statement-breakpoint
ALTER TABLE `inbox_messages` ADD `account_id` integer;
--> statement-breakpoint
ALTER TABLE `sync_records` ADD `account_id` integer;
```
Update `db/schema.ts`: `provider` no longer `.unique()`; add `userEmail`, `status`; table-level `uniqueIndex("integration_accounts_provider_user_unique").on(t.provider, t.userEmail)` (follow how other tables in schema.ts declare composite indexes); add `accountId` to inboxMessages and syncRecords.
- [ ] **Step 4:** test PASS; `pnpm test && pnpm typecheck && pnpm lint`; `pnpm db:migrate:local` twice (second no-op).
- [ ] **Step 5:** Commit `feat(db): per-user integration accounts`.

---

### Task 2: Per-user connect and callback

**Files:** `lib/integrations/accounts.ts` (create); `app/api/{microsoft,google}/connect/route.ts`, `app/api/{microsoft,google}/callback/route.ts`; test file extended.

**Interfaces — Produces** (`lib/integrations/accounts.ts`):
```ts
export type Provider = "microsoft" | "google";
export type IntegrationAccount = { id: number; provider: Provider; user_email: string; account_email: string; access_token: string; refresh_token: string; expires_at: string; scopes: string; sync_email: number; sync_calendar: number; auto_tasks: number; last_synced_at: string | null; status: string };
export function canConnectOwn(user: CRMUser): boolean;           // can(user,"records.edit")
export function canManageAll(user: CRMUser): boolean;            // can(user,"integrations.manage")
export async function ownAccount(provider: Provider, email: string): Promise<IntegrationAccount | null>;
export async function accountById(id: number): Promise<IntegrationAccount | null>;
export async function allPersonalAccounts(): Promise<IntegrationAccount[]>; // provider IN ('google','microsoft')
export async function upsertPersonalAccount(input: { provider: Provider; userEmail: string; accountEmail: string; accessTokenEnc: string; refreshTokenEnc: string; expiresAt: string; scopes: string }): Promise<number>; // ON CONFLICT(provider,user_email); keeps old refresh token when new is ''; resets status='connected'
```
- [ ] **Step 1: Failing tests** (append): an editor (`records.edit`) can start connect (`GET /api/microsoft/connect` returns a redirect and an `oauth_states` row with `actor_email` = editor); a viewer gets 403; `upsertPersonalAccount` for `a@x.com` then `b@x.com` keeps two rows; a second upsert for `a@x.com` updates in place and keeps the old refresh token when given `''`, and resets `status` to `connected`. Load route modules the way existing tests (e.g. `scripts/test-authz-hardening.mjs`) call routes; set `MS_CLIENT_ID`, `MS_CLIENT_SECRET`, `CRM_TOKEN_ENCRYPTION_KEY` in `createTestContext({...})` env overrides.
- [ ] **Step 2:** run → FAIL.
- [ ] **Step 3:** Implement helpers; connect routes check `canConnectOwn` instead of `integrations.manage`; callbacks call `upsertPersonalAccount` with `userEmail = state.actor_email` (lowercased) instead of `ON CONFLICT(provider)`; audit `integration.connect` with `{provider, userEmail, accountEmail}`.
- [ ] **Step 4:** tests PASS; full suite, typecheck, lint.
- [ ] **Step 5:** Commit `feat(integrations): connect Microsoft/Google per user`.

---

### Task 3: Per-account sync and Sync now

**Files:** Create `lib/integrations/microsoft-sync.ts`, `lib/integrations/google-sync.ts`; modify `app/api/{microsoft,google}/sync/route.ts`, `app/api/advanced/route.ts:21`; tests.

**Interfaces — Produces:**
```ts
export type SyncResult = { accountId: number; emails: number; events: number; skipped: number; reviewQueued: number };
export async function syncMicrosoftAccount(account: IntegrationAccount): Promise<SyncResult>;
export async function syncGoogleAccount(account: IntegrationAccount): Promise<SyncResult>;
export class ReconnectRequired extends Error {}   // thrown when refresh fails with invalid_grant / 401 after refresh
```
- [ ] **Step 1: Failing tests:** stub `globalThis.fetch` to return canned Graph/Gmail responses (one message from a seeded contact, one calendar event with that contact, one message from an unknown address). Assert: rows in `inbox_messages`/`activities`/`deal_activities` have `owner = account.user_email` and `inbox_messages.account_id = account.id`; `sync_records.account_id` set; unknown sender queues a communication review item exactly as before; running sync for a second account that sees the same external message id writes nothing new (global dedupe); a token-refresh 400 `invalid_grant` throws `ReconnectRequired`; `POST /api/microsoft/sync` as an editor syncs only that editor's account (another user's account `last_synced_at` unchanged) and returns 404 "Connect your Microsoft account first." when the caller has none.
- [ ] **Step 2:** run → FAIL.
- [ ] **Step 3:** Move the existing sync body from each `sync/route.ts` into the lib function UNCHANGED except: the actor/owner is `account.user_email` (resolve the CRM user via `userByEmail(account.user_email)`; if the person is no longer an active member, throw `ReconnectRequired` so their account is flagged); write `account_id`; on success update `last_synced_at` and `status='connected'`; on refresh failure set `status='needs_reconnect'` and throw `ReconnectRequired`. Routes: require `canConnectOwn`, load `ownAccount(provider, user.email)`, call the lib function, audit `integration.sync`. `app/api/advanced/route.ts:21`: replace the single `WHERE provider='microsoft'` `.first()` with the caller's own account (or the first connected account for owners/admins if it is used for an org-level status — read the code and keep behaviour sensible; note the choice in the report).
- [ ] **Step 4:** tests PASS; full suite, typecheck, lint.
- [ ] **Step 5:** Commit `refactor(integrations): per-account sync; Sync now syncs your own account`.

---

### Task 4: Integrations API — own and team connections

**Files:** `app/api/integrations/route.ts`; tests.

**Interfaces — Produces:** `GET /api/integrations` → existing fields plus `personal: { mine: AccountView[]; team: AccountView[] | null }` where `AccountView = { id; provider; userEmail; userName; accountEmail; lastSyncedAt; status; syncEmail; syncCalendar; autoTasks }` (no tokens); `team` only for `canManageAll`. POST actions: `savePreferences {id, syncEmail, syncCalendar, autoTasks}` (own account, or any for managers; audit `integration.preferences`), `disconnect {id}` (own, or any for managers; Google revoked at provider; deletes only that row; audit `integration.disconnect` with `{provider, userEmail, by}`). QuickBooks/Meetily actions unchanged (still `integrations.manage`, keyed by provider with `user_email=''`).
- [ ] **Step 1: Failing tests:** editor sees only own in `mine` and `team=null`; owner sees both; editor disconnecting another user's id → 403; owner disconnecting editor's → ok + audit row with `by`; no response contains `access_token`/`refresh_token`; QuickBooks disconnect still admin-only.
- [ ] **Step 2:** FAIL. **Step 3:** implement. **Step 4:** PASS + suite/typecheck/lint. **Step 5:** Commit `feat(integrations): own and team connection management API`.

---

### Task 5: Automatic sync

**Files:** Create `lib/integrations/sync-all.ts`; modify `lib/scheduled-jobs.ts`, `lib/operations.ts` (`runDailyMaintenance`); tests.

**Interfaces — Produces:** `export async function syncAllAccounts(now?: Date): Promise<{ synced: number; skipped: number; failed: { accountId: number; userEmail: string; error: string }[] }>` — skips accounts with `last_synced_at` within 50 minutes or `status='needs_reconnect'`; records one `job_runs` row (`job_type='mail-sync'`); per-account failures → `systemEvent("warning","integration",…)`, never thrown.
- [ ] **Step 1: Failing tests:** two accounts, one whose fetch stub fails with `invalid_grant` → result `synced:1, failed:[…]`, failing account `status='needs_reconnect'`, other synced; a second call within 50 minutes skips both; `runScheduled` at a non-6 AM hour calls `syncAllAccounts` (spy via module seam or by asserting a `job_runs` `mail-sync` row); daily maintenance also records a `mail-sync` row.
- [ ] **Step 2:** FAIL. **Step 3:** implement; call `syncAllAccounts()` in `runScheduled` every hour (after sequences/maintenance, wrapped in the existing `attempt`) and inside `runDailyMaintenance` (after sequences, before backup; failures must not fail maintenance). **Step 4:** PASS + suite/typecheck/lint. **Step 5:** Commit `feat(integrations): sync every connected account automatically`.

---

### Task 6: Email & calendar screen and mailbox labels

**Files:** Create `components/email-calendar.tsx`; modify `lib/navigation.ts` (add `{id:"connections",label:"Email & calendar"}` to More, first item), `app/page.tsx` (icon + render), `components/production-workspace.tsx` (Google/Microsoft panels replaced by a link/button "Manage in Email & calendar"), Inbox and activity list components (label); `scripts/test-nav.mjs` expectations.

**Interfaces — Consumes:** Task 4 API.
- [ ] **Step 1:** Update `scripts/test-nav.mjs` to expect `connections` first in More; run → FAIL.
- [ ] **Step 2:** Build the screen: "Your connections" — one card per provider: not connected → Connect button (`<a href="/api/{provider}/connect">`, hidden for viewers with an explanation); connected → account email, last synced, status badge ("Needs reconnecting" with Reconnect button), preference toggles (save via `savePreferences`), Sync now (POST `/api/{provider}/sync`, shows counts), Disconnect (confirm). "Team connections" (only when `team` present) — table: person, provider, account email, last synced, status, Disconnect (confirm naming the person). Match the styling of existing workspaces.
- [ ] **Step 3:** Mailbox labels: where synced emails/meetings are listed (shared inbox list and deal/contact activity lists), show "From {owner display name}'s mailbox" for rows with `source` Google/Microsoft or `account_id` not null — find the components rendering `inbox_messages` and `deal_activities` and add a small muted label; no layout changes beyond that.
- [ ] **Step 4:** `node scripts/test-nav.mjs`, `pnpm test && pnpm typecheck && pnpm lint && pnpm build`; browser smoke (`pnpm dev`, local seeded accounts for owner + an editor: owner sees team table, Connect button visible, Sync now works with a stubbed provider or shows the provider error cleanly). Stop dev server.
- [ ] **Step 5:** Commit `feat: Email & calendar screen for personal connections`.

---

### Task 7: Docs and verification

- [ ] README: replace the Google/Microsoft integration notes with: each person connects under More → Email & calendar; owners/admins manage team connections; automatic hourly sync (daily fallback); rollout steps from the spec (redirect URIs `https://clientrecordcrm.com/api/microsoft/callback` and `/api/google/callback`, env/secrets `MS_CLIENT_ID`, `MS_CLIENT_SECRET`, `MS_TENANT_ID`, `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, Microsoft 365 admin consent for `Mail.Read`/`Calendars.Read`).
- [ ] Full verification: `pnpm test && pnpm typecheck && pnpm lint && pnpm build`; `pnpm --filter clientrecord-mcp typecheck`.
- [ ] Commit `docs: personal Microsoft and Google connections`.
