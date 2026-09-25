# ClientRecord CRM

A one-page CRM (contacts, companies, deals and pipelines, activities, campaigns, proposals, customer success, AI-assisted workflows) that runs as a single [vinext](https://github.com/cloudflare/vinext) (Next.js App Router on Vite) app on **Cloudflare Workers**, with **D1** (SQLite) for data and **R2** for documents and transcripts.

## Local development

Requires Node.js `>=22.13.0` and pnpm (version pinned in `packageManager`).

```sh
pnpm install
pnpm dev        # vinext dev server with HMR on http://localhost:5173
```

Local sign-in: under the dev server (`NODE_ENV=development`) requests to `localhost`, `127.0.0.1` or `terminal.local` are treated as the owner account (`DEFAULT_OWNER_EMAIL` in `lib/crm-auth.ts`), so no sign-in step is needed. This bypass is compiled out of production builds. `pnpm start` runs the *built* Worker and has no bypass: requests need real identity headers (see [Authentication](#authentication)).

`vite.config.ts` simulates the D1 (`DB`) and R2 (`BUCKET`) bindings locally; state lives in the ignored `.wrangler/state`.

## Commands

| Command | What it does |
| --- | --- |
| `pnpm dev` | Start the vinext dev server |
| `pnpm build` | Build the deployable Worker into `dist/` (also writes `dist/server/wrangler.json`) |
| `pnpm start` | Run the built Worker locally through Wrangler with local D1/R2 |
| `pnpm lint` | ESLint |
| `pnpm typecheck` | `tsc --noEmit -p .` |
| `pnpm test` | Run every `scripts/test-*.mjs` (in-memory SQLite with all migrations; see `scripts/test-helpers.mjs`) |
| `pnpm db:generate` | Generate a Drizzle migration in `drizzle/` from `db/schema.ts` |

### Secret scanning

A pre-commit hook in `.githooks/pre-commit` runs [gitleaks](https://github.com/gitleaks/gitleaks) on staged changes and blocks commits that add secrets. Enable it once per clone with `brew install gitleaks` and `git config core.hooksPath .githooks`. Known false positives go in `.gitleaksignore`.

## Database and migrations

`db/schema.ts` is the source of truth for the schema and is used only by drizzle-kit to generate SQL; the app itself queries D1 with raw SQL through the `DB` binding. After editing the schema run `pnpm db:generate`, review the generated `drizzle/NNNN_*.sql`, and commit it with `drizzle/meta/`.

To apply migrations to the local preview database, build once (`pnpm build`, rebuilding if bindings change) so `dist/server/wrangler.json` exists, then apply each pending migration in order from the project root:

```sh
node --import ./scripts/sites-env.mjs ./node_modules/wrangler/bin/wrangler.js d1 execute DB --local --config dist/server/wrangler.json --persist-to .wrangler/state --file drizzle/0000_brown_justin_hammer.sql
```

Use `.wrangler/state`, not `.wrangler/state/v3` (Wrangler adds the versioned directories), and do not replay migrations already applied locally. This updates only the preview database; production migrations are applied separately at publish time.

## Configuration

Bindings and variables are typed in `cloudflare-env.d.ts`. Features whose variables are missing are reported as "not configured" in the UI rather than failing.

| Variable | Required | Purpose |
| --- | --- | --- |
| `DB` (D1 binding) | yes | CRM database |
| `BUCKET` (R2 binding) | yes | Documents, transcripts, backups |
| `CRM_ALLOWED_EMAILS` | recommended | Comma-separated owner emails. Other users need an active `team_members` row (owner/admin/editor/viewer). Falls back to `DEFAULT_OWNER_EMAIL` when unset |
| `CRM_TOKEN_ENCRYPTION_KEY` | for integrations/email | Base64 AES key (e.g. `openssl rand -base64 32`). Encrypts stored OAuth tokens (Google, Microsoft, QuickBooks) and signs unsubscribe links |
| `CF_ACCESS_TEAM_DOMAIN`, `CF_ACCESS_AUD` | optional | Cloudflare Access team domain and application audience; enables JWT verification |
| `CF_ACCESS_ENFORCED` | optional | See [Authentication](#authentication) |
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

1. A valid Cloudflare Access JWT (`Cf-Access-Jwt-Assertion`), when `CF_ACCESS_TEAM_DOMAIN` and `CF_ACCESS_AUD` are set.
2. Otherwise the hosting platform's identity headers `oai-authenticated-user-id` / `oai-authenticated-user-email`. These are spoofable by anyone who can reach the origin directly, so once Access is configured they are **no longer trusted** unless `CF_ACCESS_ENFORCED=false` (staged-rollout escape hatch). `CF_ACCESS_ENFORCED=true` always requires Access.

The resolved email must be in `CRM_ALLOWED_EMAILS` (owner) or an active team member; roles map to permissions in `lib/crm-auth.ts`.

> **Deployment check:** without Cloudflare Access, anyone who can send requests straight to the Worker (for example through a `*.workers.dev` URL or another route that bypasses the Sites platform) can claim any identity with those headers. Either make sure the Worker is only reachable through Sites, or configure Cloudflare Access and set `CF_ACCESS_ENFORCED=true`.

### API keys and OpenAPI

Machine clients use scoped API keys (`Authorization: Bearer cr_live_…`), created in the app and stored only as SHA-256 hashes. Scopes: `records.read`, `records.write`, `leads.capture`, `inbox.capture`, `meetings.import`, `jobs.run`, `backups.export`, or `*`. Only owners can create `*` and `backups.export` keys, and `*` does not grant `backups.export`. The OpenAPI 3.1 description of the public API (`/api/v1/records`, Meetily import, scheduled jobs via `/api/operations`) is served at `GET /api/openapi`.

## Data export & migration

`GET /api/backup-export` exports everything needed to move the CRM to another Cloudflare account (D1 + R2). It is owner-only: a signed-in owner, or an API key that lists the `backups.export` scope (only owners can create one; `*` keys do not qualify). Modes: `?part=tables`, `?table=<name>&offset=&limit=` (JSON pages, ≤1000 rows), `?table=<name>&format=csv`, `?part=manifest` (every R2 object the data references: document versions and field-capture media) and `?object=<key>` (only keys listed in the manifest). Tables are discovered from `sqlite_master`; internal tables and the denylist in `lib/backup-export.ts` (`BACKUP_EXPORT_EXCLUDED_TABLES`: OAuth state, rate limits, undo log, encrypted integration tokens, webhook endpoints/deliveries, old backup snapshots) are skipped, so integrations and webhooks must be reconnected after the move. `api_keys` is kept (hashes only), so existing clients such as Meetily keep working.

1. **Create an export key.** As an owner, in Settings → API keys create a key with scope `backups.export`. Revoke it when the migration is done.
2. **Create a Cloudflare Access service token.** `clientrecordcrm.com` is behind Cloudflare Access, so a script can't reach it with the API key alone. In Zero Trust → Access → Service Auth, create a service token, then add a policy with action **Service Auth** that includes that token to the application protecting the site.
3. **Export from the live site** (Node 22, no extra dependencies; re-run to resume, it skips objects already downloaded with a matching checksum):

   ```bash
   CRM_EXPORT_KEY=cr_live_... CF_ACCESS_CLIENT_ID=....access CF_ACCESS_CLIENT_SECRET=... \
     node scripts/export-from-live.mjs --url https://clientrecordcrm.com --out ./migration-export
   ```

   This writes `tables/<name>.json` (the import source of truth), `csv/<name>.csv` (for people), `manifest.json`, `objects/<key>` and `export-info.json`. It exits non-zero if any object is missing or fails its SHA-256 checksum. Keep the directory private; it holds all CRM data.
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
- **Cloudflare Access** – optional front-door authentication (also supports service tokens)
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
scripts/                dev/build wrappers and test-*.mjs suites
build/, vite.config.ts  Sites Vite plugin and Worker build config
```

## Sites hosting notes

The project is hosted as an OpenAI Sites app. `.openai/hosting.json` declares the project id and the `DB`/`BUCKET` bindings; the Worker name comes from `package.json` `name`. The platform owns `/signin-with-chatgpt`, `/signout-with-chatgpt` and `/callback` and injects the `oai-authenticated-user-*` headers (the optional full name arrives percent-encoded with `oai-authenticated-user-full-name-encoding: percent-encoded-utf-8`); do not implement those routes. The ignored `.sites-runtime/` holds checkout-local tool state and must not be committed.
