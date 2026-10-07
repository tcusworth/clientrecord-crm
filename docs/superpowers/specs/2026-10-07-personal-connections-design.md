# Personal Microsoft and Google connections — design

**Status:** Approved in conversation 2026-10-07 · **Owner:** trevor.cusworth@csi-automation.com

## Goal

Each team member connects their own Microsoft 365 or Google mailbox and calendar to ClientRecord, instead of one shared connection per provider.

## Current state

- `integration_accounts` holds at most one row per provider (UNIQUE index on `provider`); Google/Microsoft callbacks upsert `ON CONFLICT(provider)`. QuickBooks uses the same table. Production has **no** connected accounts.
- Connect, sync, preferences and disconnect require `integrations.manage` (owner/admin). Settings → Integrations is in the Admin menu.
- Sync is manual only (POST `/api/{google,microsoft}/sync`): email from the last 30 days (Microsoft top 100, Gmail 50), calendar −30…+180 days (max 100). Only items matching a CRM contact are kept; writes `activities`, `inbox_messages`, `deal_activities`, optional follow-up `tasks`/`deal_tasks`, attachments, communication-review items; dedupe via `sync_records.external_id` (global) and `inbox_messages (provider, external_id)`. Rows record `owner = <syncing CRM user>`; there is no link to the source account.
- Synced data is visible to every signed-in user (no owner filtering).
- Scopes are read-only (Microsoft `offline_access User.Read Mail.Read Calendars.Read`; Google `openid email gmail.readonly calendar.readonly`). Tokens are AES-GCM encrypted with `CRM_TOKEN_ENCRYPTION_KEY`. Nothing is sent through these providers (outbound mail is Resend).

## Decisions (owner)

| Topic | Decision |
|---|---|
| Who sees synced mail | Everyone sees CRM-matched email/meetings (as today), each labelled with whose mailbox it came from. |
| Sync timing | Automatic for every connected account (hourly schedule; daily page-load fallback until the Cloudflare cron issue is fixed) + "Sync now" for your own account. |
| Control | Each person connects/manages their own; owners/admins see all connections and can disconnect any. |
| Providers | Microsoft and Google both become per-person. QuickBooks stays one company-wide connection (owner/admin only). |

## Design

### Data
- Add `user_email TEXT NOT NULL DEFAULT ''` to `integration_accounts` (lowercased CRM user email; `''` = company-wide, used by QuickBooks).
- Replace the UNIQUE index on `provider` with UNIQUE `(provider, user_email)`. Migration is schema + data-safe: production has no Google/Microsoft rows; any existing row keeps `user_email=''` (QuickBooks) — Google/Microsoft rows with `''`, if any exist on another install, are assigned to the built-in owner.
- Add `account_id INTEGER` (nullable) to `inbox_messages` and `sync_records` so synced items can be traced to the connection; the visible label uses the existing `owner` column (= the mailbox owner, since each account syncs as its owner).
- Callback upserts `ON CONFLICT(provider, user_email)` using the `oauth_states.actor_email` of the person who started the connect.

### Permissions
- Connect / Sync now / preferences / disconnect **own** Google or Microsoft account: any user with `records.edit`.
- See all connections and disconnect **any** Google/Microsoft account: `integrations.manage` (owner/admin).
- QuickBooks: unchanged (`integrations.manage`).
- Viewers can't connect.

### Sync
- Extract the existing per-provider sync bodies into `syncAccount(account)` functions (Microsoft and Google) that run **as the account's owner** (rows get `owner = account.user_email`, `account_id = account.id`, notifications go to that owner). Matching, dedupe and windows are unchanged.
- **Sync now** (POST `/api/{provider}/sync`): syncs the caller's own account only.
- **Automatic:** `syncAllAccounts()` iterates every Google/Microsoft account, syncing each with its preferences; one account's failure is recorded (job_runs/system event + account marked `status='needs_reconnect'` on token failure) and never stops the others. Called from the hourly scheduled run and from daily maintenance (so the page-load fallback covers it while the cron is broken). A per-account guard skips an account synced in the last 50 minutes to avoid double work.
- Dedupe stays global: an email both people received is stored once, labelled with whoever synced first.

### Screens
- New **Email & calendar** screen in the **More** menu, visible to all users:
  - **Your connections:** Microsoft and Google cards — Connect, connected address, last synced, status, preferences (sync email / calendar / follow-up tasks), Sync now, Disconnect.
  - **Team connections** (owners/admins): person, provider, connected address, last synced, status, Disconnect.
- Settings → Integrations keeps QuickBooks and Meetily; its Google/Microsoft panels point to the new screen.
- Synced emails and meetings show "from <person>'s mailbox" where they are listed (Inbox, contact/deal activity).

### Safety
- Read-only scopes unchanged; nothing is sent from anyone's mailbox.
- Tokens stay encrypted; never returned to the browser.
- Audit log entries for connect, disconnect (including who disconnected whose account), preferences and sync runs.
- Disconnect revokes at the provider where supported (Google) and deletes only that account row; already-synced data stays.

## Out of scope
Sending email or creating calendar events through Microsoft/Google, per-person visibility restrictions, shared mailboxes/delegation, and migrating Meetily.

## Testing
- Migration: unique `(provider, user_email)` allows one Microsoft account per person and still only one QuickBooks; existing QuickBooks row unaffected.
- Permissions: editor can connect/sync/disconnect own, not others; owner/admin can list and disconnect any; viewer cannot connect; QuickBooks still admin-only.
- Callback stores the account under the state's actor; a second person's connect does not overwrite the first.
- Sync: rows written with the account owner and `account_id`; Sync now only touches the caller's account; `syncAllAccounts` continues past a failing account and marks it needs-reconnect; 50-minute guard; global dedupe across two mailboxes.
- UI: Email & calendar screen renders own and team sections by role; More menu entry; existing tests pass; lint 0 errors; build passes.

## Rollout (owner)
1. Deploy (migration applies automatically).
2. Microsoft: ensure the app registration's redirect URIs include `https://clientrecordcrm.com/api/microsoft/callback` (and `new.` if used) and `MS_CLIENT_ID`/`MS_CLIENT_SECRET` (and `MS_TENANT_ID` for CSI's tenant) are set; if CSI's Microsoft 365 requires admin consent for `Mail.Read`, a 365 admin grants consent once.
3. Google (optional): same for the Google OAuth client.
4. Each person opens **More → Email & calendar** and connects.
