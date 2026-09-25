# ClientRecord CRM

A one-page CRM (contacts, companies, deals and pipelines, activities, campaigns, proposals, customer success, AI-assisted workflows) that runs as a single [vinext](https://github.com/cloudflare/vinext) (Next.js App Router on Vite) app on **Cloudflare Workers**, with **D1** (SQLite) for data and **R2** for documents and transcripts.

## Local development

Requires Node.js `>=22.13.0` and pnpm (version pinned in `packageManager`).

```sh
pnpm install
pnpm db:migrate:local   # apply drizzle/*.sql to the local D1 simulation (.wrangler/state)
pnpm dev                # vinext dev server with HMR on http://localhost:3000
```

Local sign-in: under the dev server (`NODE_ENV=development`) requests to `localhost`, `127.0.0.1` or `terminal.local` are treated as the owner account (`DEFAULT_OWNER_EMAIL` in `lib/crm-auth.ts`), so no sign-in step is needed. This bypass is compiled out of production builds. `pnpm start` runs the *built* Worker and has no bypass: requests need a Cloudflare Access JWT (see [Authentication](#authentication)); to click around the built Worker locally, put `CF_ACCESS_ENFORCED=false` and `TRUST_PLATFORM_IDENTITY_HEADERS=true` in an ignored `.dev.vars` and send `oai-authenticated-user-id`/`-email` headers.

Bindings come from `wrangler.jsonc` (which `vite.config.ts` points `@cloudflare/vite-plugin` at). In `pnpm dev`/`pnpm start` D1 (`DB`) and R2 (`BUCKET`) are simulated locally in the ignored `.wrangler/state`; nothing touches the real Cloudflare resources. Local secrets go in an ignored `.dev.vars` (same names as the production secrets below).

## Commands

| Command | What it does |
| --- | --- |
| `pnpm dev` | Start the vinext dev server |
| `pnpm build` | Build the deployable Worker into `dist/` (also writes `dist/server/wrangler.json`) |
| `pnpm start` | Run the built Worker locally through Wrangler (`wrangler dev --local`) with local D1/R2 on http://127.0.0.1:8787 |
| `pnpm db:migrate:local` | Apply pending `drizzle/*.sql` migrations to the local D1 simulation |
| `pnpm run deploy` | Build, apply pending migrations to the **remote** D1, then `wrangler deploy` (see [Hosting on Cloudflare](#hosting-on-cloudflare)) |
| `pnpm lint` | ESLint |
| `pnpm typecheck` | `tsc --noEmit -p .` |
| `pnpm test` | Run every `scripts/test-*.mjs` (in-memory SQLite with all migrations; see `scripts/test-helpers.mjs`) |
| `pnpm db:generate` | Generate a Drizzle migration in `drizzle/` from `db/schema.ts` |

### Secret scanning

A pre-commit hook in `.githooks/pre-commit` runs [gitleaks](https://github.com/gitleaks/gitleaks) on staged changes and blocks commits that add secrets. Enable it once per clone with `brew install gitleaks` and `git config core.hooksPath .githooks`. Known false positives go in `.gitleaksignore`.

## Database and migrations

`db/schema.ts` is the source of truth for the schema and is used only by drizzle-kit to generate SQL; the app itself queries D1 with raw SQL through the `DB` binding. After editing the schema run `pnpm db:generate`, review the generated `drizzle/NNNN_*.sql`, and commit it with `drizzle/meta/`.

Migrations are applied with Wrangler's D1 migration runner (`migrations_dir: "drizzle"` in `wrangler.jsonc`). It reads only the top-level `drizzle/*.sql` files (ignoring `drizzle/meta/`), applies them in filename order, and records each applied filename in a `d1_migrations` table, so re-running only applies new files:

```sh
pnpm db:migrate:local                                            # local simulation
pnpm exec wrangler d1 migrations apply DB --remote --config wrangler.jsonc   # production (also done by `pnpm run deploy`)
```

Always pass `--config wrangler.jsonc` to D1 commands: after a build, Wrangler otherwise follows `.wrangler/deploy/config.json` to `dist/server/wrangler.json`, where the relative `migrations_dir` does not resolve.

## Configuration

Bindings and variables are typed in `cloudflare-env.d.ts`. Features whose variables are missing are reported as "not configured" in the UI rather than failing.

| Variable | Required | Purpose |
| --- | --- | --- |
| `DB` (D1 binding) | yes | CRM database |
| `BUCKET` (R2 binding) | yes | Documents, transcripts, backups |
| `CRM_ALLOWED_EMAILS` | recommended | Comma-separated owner emails. Other users need an active `team_members` row (owner/admin/editor/viewer). Falls back to `DEFAULT_OWNER_EMAIL` when unset |
| `CRM_TOKEN_ENCRYPTION_KEY` | for integrations/email | Base64 AES key (e.g. `openssl rand -base64 32`). Encrypts stored OAuth tokens (Google, Microsoft, QuickBooks) and signs unsubscribe links |
| `CF_ACCESS_TEAM_DOMAIN` | yes (var in `wrangler.jsonc`) | Cloudflare Access team domain (`https://tcusworth.cloudflareaccess.com`) |
| `CF_ACCESS_AUD` | yes (secret) | Audience (AUD) tag of the Access application for the Worker's hostname; enables JWT verification |
| `CF_ACCESS_ENFORCED` | var, `true` | See [Authentication](#authentication) |
| `TRUST_PLATFORM_IDENTITY_HEADERS` | no | Only for legacy OpenAI Sites hosting; leave unset on Cloudflare. See [Authentication](#authentication) |
| `RESEND_API_KEY`, `RESEND_FROM_EMAIL`, `RESEND_WEBHOOK_SECRET` | optional | Campaign/transactional email via Resend and its signed webhook (`/api/resend/webhook`) |
| `OPENAI_API_KEY` | optional | AI features (OpenAI Responses API) |
| `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` | optional | Gmail + Google Calendar sync (read-only) |
| `MS_CLIENT_ID`, `MS_CLIENT_SECRET`, `MS_TENANT_ID` | optional | Microsoft 365 mail/calendar sync via Microsoft Graph |
| `QUICKBOOKS_CLIENT_ID`, `QUICKBOOKS_CLIENT_SECRET` | optional | QuickBooks Online billing connection |
| `QUICKBOOKS_ENVIRONMENT` | optional | `sandbox` to use the Intuit sandbox API; production otherwise |
| `QUICKBOOKS_DEFAULT_ITEM_ID` | optional | QuickBooks item used for invoice lines |
| `APOLLO_API_KEY` | optional | Company enrichment via Apollo |

OAuth redirect URIs follow `https://<host>/api/{google,microsoft,quickbooks}/callback`.

## Authentication

`crmUser()` in `lib/crm-auth.ts` resolves the caller:

1. A valid Cloudflare Access JWT (`Cf-Access-Jwt-Assertion`), verified against `CF_ACCESS_TEAM_DOMAIN`'s signing keys and `CF_ACCESS_AUD`. This is the only identity source on Cloudflare hosting.
2. Legacy OpenAI Sites identity headers (`oai-authenticated-user-id` / `oai-authenticated-user-email`) are spoofable by anyone who can reach the origin, so they are ignored unless `TRUST_PLATFORM_IDENTITY_HEADERS` is exactly `true` **and** either Access is not configured or `CF_ACCESS_ENFORCED=false`. `CF_ACCESS_ENFORCED=true` always requires Access.
3. Under `pnpm dev` only, localhost requests are the owner (see [Local development](#local-development)).

The resolved email must be in `CRM_ALLOWED_EMAILS` (owner) or an active team member; roles map to permissions in `lib/crm-auth.ts`.

With `CF_ACCESS_ENFORCED=true` and `CF_ACCESS_AUD` missing or wrong, every signed-in request fails closed with 401. `wrangler.jsonc` disables `workers_dev` and preview URLs so the Worker is reachable only through its Access-protected custom domain.

### API keys and OpenAPI

Machine clients use scoped API keys (`Authorization: Bearer cr_live_…`), created in the app and stored only as SHA-256 hashes. Scopes: `records.read`, `records.write`, `leads.capture`, `inbox.capture`, `meetings.import`, `jobs.run`, `backups.export`, or `*`. Only owners can create `*` and `backups.export` keys, and `*` does not grant `backups.export`. The OpenAPI 3.1 description of the public API (`/api/v1/records`, Meetily import, scheduled jobs via `/api/operations`) is served at `GET /api/openapi`.

## Data export & migration

> **Moving from a site that predates `/api/backup-export`?** Download `/api/export?type=backup` (one JSON file) as the owner, download each document into a folder, then convert both into the import layout: `node scripts/convert-legacy-backup.mjs --backup ./migration-export/crm-account-backup.json --documents ./migration-export/documents --out ./migration-export/converted`. Files are matched to their records by SHA-256, so their names don't matter. Then run the import step below with `--in ./migration-export/converted`. That backup leaves out a few newer areas (customer success, partners, service cases, custom objects, field captures, QuickBooks invoices, portal access, API keys); check they're empty or re-create them.

`GET /api/backup-export` exports everything needed to move the CRM to another Cloudflare account (D1 + R2). It is owner-only: a signed-in owner, or an API key that lists the `backups.export` scope (only owners can create one; `*` keys do not qualify). Modes: `?part=tables`, `?table=<name>&offset=&limit=` (JSON pages, ≤1000 rows), `?table=<name>&format=csv`, `?part=manifest` (every R2 object the data references: document versions and field-capture media) and `?object=<key>` (only keys listed in the manifest). Tables are discovered from `sqlite_master`; internal tables and the denylist in `lib/backup-export.ts` (`BACKUP_EXPORT_EXCLUDED_TABLES`: OAuth state, rate limits, undo log, encrypted integration tokens, webhook endpoints/deliveries, old backup snapshots) are skipped, so integrations and webhooks must be reconnected after the move. `api_keys` is kept (hashes only), so existing clients such as Meetily keep working.

1. **Create an export key.** As an owner, in Settings → API keys create a key with scope `backups.export`. Revoke it when the migration is done.
2. **Create a Cloudflare Access service token.** `clientrecordcrm.com` is behind Cloudflare Access, so a script can't reach it with the API key alone. In Zero Trust → Access → Service Auth, create a service token, then add a policy with action **Service Auth** that includes that token to the application protecting the site.
3. **Export from the live site** (Node 22, no extra dependencies; re-run to resume, it skips objects already downloaded with a matching checksum):

   ```bash
   CRM_EXPORT_KEY=cr_live_... CF_ACCESS_CLIENT_ID=....access CF_ACCESS_CLIENT_SECRET=... \
     node scripts/export-from-live.mjs --url https://clientrecordcrm.com --out ./migration-export
   ```

   This writes `tables/<name>.json` (the import source of truth), `csv/<name>.csv` (for people), `manifest.json`, `objects/<key>` and `export-info.json`. It exits non-zero if any object is missing or fails its SHA-256 checksum. Keep the directory private: it holds all CRM data, including every proposal's live share link token (anyone with a token can open and sign that proposal). Don't sync it to cloud storage, and delete it once the import is verified. Share tokens are kept on purpose so links already sent to clients keep working; if the folder may have been exposed, regenerate links for unsigned proposals after the move.
4. **Prepare the target.** Create the D1 database `clientrecord-crm-db` and the R2 bucket `clientrecord-crm-files`, then apply every `drizzle/*.sql` migration to the database.
5. **Import** (`--local` or `--remote` is required; `--dry-run` only writes the SQL and prints the plan):

   ```bash
   node scripts/import-to-cloudflare.mjs --in ./migration-export --database clientrecord-crm-db --bucket clientrecord-crm-files --remote --dry-run
   node scripts/import-to-cloudflare.mjs --in ./migration-export --database clientrecord-crm-db --bucket clientrecord-crm-files --remote
   ```

   The script checks that every exported table exists in the target, refuses tables that already have rows unless `--force`, writes chunked SQL files to `migration-export/import-sql/` (each starting with `PRAGMA defer_foreign_keys = on;`, parents before children using the target's foreign keys, only columns the target has), runs them with `wrangler d1 execute`, uploads objects with `wrangler r2 object put` under the same keys, and then verifies row and object counts (non-zero exit on mismatch). `--config` and `--persist-to` are passed through to wrangler for local rehearsals, for example `--local --config dist/server/wrangler.json --persist-to .wrangler/import-check --database DB --bucket BUCKET`.

## External services

- **Resend** – campaigns, transactional email, delivery webhooks
- **OpenAI** – AI record fields, follow-up drafts, meeting intelligence, proposals (governed via AI settings)
- **Google** – Gmail and Calendar sync
- **Microsoft Graph** – Microsoft 365 mail and calendar sync
- **QuickBooks Online** – customer and invoice billing
- **Apollo** – company enrichment
- **Cloudflare Access** – front-door authentication for the app (also supports service tokens)
- **Meetily** – meeting summary/transcript import; see `docs/meetily-integration.md` and `integrations/meetily/`

## Architecture

```
app/page.tsx            single-page CRM shell (client)
app/api/<feature>/      route handlers (JSON APIs per feature; v1/ is the keyed public API)
app/portal, proposal, unsubscribe   public/customer-facing pages
components/             feature workspaces; components/ui is vendored shadcn
lib/                    domain logic, auth (crm-auth.ts), integrations (google, microsoft, quickbooks, resend, ...)
db/schema.ts            Drizzle schema (migration generation only)
drizzle/                ordered SQL migrations + drizzle-kit metadata
scripts/                test-*.mjs suites and test harness
wrangler.jsonc          Worker name, route, bindings, vars (source of truth for deploy)
vite.config.ts          vinext + @cloudflare/vite-plugin build config
```


## Hosting on Cloudflare

The app runs as the Worker `clientrecord-crm` in the "Flatirons Creative Studio" account (`account_id` in `wrangler.jsonc`), with D1 database `clientrecord-crm-db` (binding `DB`) and R2 bucket `clientrecord-crm-files` (binding `BUCKET`). It is served only on the custom domain in `wrangler.jsonc` `routes` (`new.clientrecordcrm.com` until cutover); `workers_dev` and `preview_urls` are off so nothing bypasses Cloudflare Access.

How deploy works: `pnpm build` (`vinext build` + `@cloudflare/vite-plugin`) reads `wrangler.jsonc` and writes the deployable config to `dist/server/wrangler.json` plus a redirect file `.wrangler/deploy/config.json`. A plain `wrangler deploy` (no `--config`) follows that redirect and uploads the built Worker and `dist/client` assets. `pnpm run deploy` does build → `wrangler d1 migrations apply DB --remote --config wrangler.jsonc` (asks for confirmation when there are pending migrations) → `wrangler deploy`. Use `pnpm exec wrangler deploy --dry-run` after a build to check bindings without uploading. vinext also documents `npx @vinext/cloudflare deploy`, which is not installed here; the steps above are equivalent.

Non-secret settings are `vars` in `wrangler.jsonc` and are rewritten on every deploy. Everything else is a Worker secret (`pnpm exec wrangler secret put NAME`), which deploys leave alone. `CF_ACCESS_AUD` is a secret rather than a var so it can differ per Access application (it changes at cutover) without editing the repo, and so a deploy can never reset it.

### Moving off OpenAI Sites

Prerequisites: `pnpm exec wrangler login` as the account owner (`pnpm exec wrangler whoami` should list Flatirons Creative Studio). `new.clientrecordcrm.com` must not already have a DNS record; `wrangler deploy` creates it for the custom domain.

1. **Access application for `new.clientrecordcrm.com`.** In Zero Trust → Access → Applications, add a self-hosted application for `new.clientrecordcrm.com` with the same identity policy as the existing `clientrecordcrm.com` application. Copy its **Application Audience (AUD) tag**. Then add a second self-hosted application on the same hostname whose destinations are the public paths below, with a single **Bypass** policy (Everyone). Access applies the most specific path match, so these skip the login screen:
   - Customer/public pages and their APIs: `/portal*`, `/proposal/*`, `/unsubscribe*`, `/api/portal*`, `/api/proposal-public*`, `/api/unsubscribe*` (protected by per-link tokens in the app)
   - Webhooks and OAuth callbacks: `/api/resend/webhook*` (Resend signature), `/api/google/callback`, `/api/microsoft/callback`, `/api/quickbooks/callback` (OAuth `state` check)
   - API-key endpoints: `/api/v1/*`, `/api/lead-capture*`, `/api/inbox-capture*`, `/api/integrations/meetily/meetings*`. These still require a scoped `Authorization: Bearer cr_live_…` key; without one they return 401. (Alternatively keep them behind Access and give clients a Service Auth token, as `docs/meetily-integration.md` describes.)
2. **Deploy.** `pnpm install && pnpm run deploy`. The first run applies all migrations to the empty remote D1 and creates the custom domain. Until step 3 is done every signed-in request returns 401 (fail closed).
3. **Secrets.** Run `pnpm exec wrangler secret put NAME` for each, copying values from the Sites environment:
   - `CF_ACCESS_AUD` (the AUD tag from step 1)
   - `CRM_ALLOWED_EMAILS`, `CRM_TOKEN_ENCRYPTION_KEY` (a fresh key is fine: the export leaves out OAuth tokens and webhook secrets, which are the only data encrypted with it, so you reconnect integrations and recreate webhooks on the new site instead)
   - `RESEND_API_KEY`, `RESEND_FROM_EMAIL`, `RESEND_WEBHOOK_SECRET`
   - `OPENAI_API_KEY`, `APOLLO_API_KEY`
   - `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`
   - `MS_CLIENT_ID`, `MS_CLIENT_SECRET`, `MS_TENANT_ID`
   - `QUICKBOOKS_CLIENT_ID`, `QUICKBOOKS_CLIENT_SECRET`, `QUICKBOOKS_ENVIRONMENT`, `QUICKBOOKS_DEFAULT_ITEM_ID`

   Do not set `TRUST_PLATFORM_IDENTITY_HEADERS`. Each `secret put` takes effect immediately. Check sign-in at `https://new.clientrecordcrm.com`.
4. **Data.** Export from Sites and import into `clientrecord-crm-db` / `clientrecord-crm-files` with the scripts described in the "Data export & migration" section (added on the `feat/backup-export` branch). Import after step 2 so the schema exists.
5. **Repoint integrations** to `https://new.clientrecordcrm.com`:
   - OAuth redirect URIs: `/api/google/callback` (Google Cloud console), `/api/microsoft/callback` (Entra app registration), `/api/quickbooks/callback` (Intuit developer app). Add the new URIs alongside the old ones during the transition.
   - Resend: add a webhook to `/api/resend/webhook`; if Resend issues a new signing secret, update `RESEND_WEBHOOK_SECRET`.
   - Meetily: in Settings → ClientRecord, change the receiver endpoint to `/api/integrations/meetily/meetings` on the new host (imported API keys keep working).
6. **Cutover to `clientrecordcrm.com`.** Once the new host is verified: move the existing Access application (or create one) to cover `clientrecordcrm.com` with the same policies and bypass paths, and set `CF_ACCESS_AUD` to that application's AUD. Remove the DNS record that points `clientrecordcrm.com` at Sites, change `routes` in `wrangler.jsonc` to `[{ "pattern": "clientrecordcrm.com", "custom_domain": true }]`, and `pnpm run deploy`. Update the OAuth redirect URIs, Resend webhook and Meetily endpoint to the apex host. Keep the Sites app running read-only for a week as a fallback, then retire it.
