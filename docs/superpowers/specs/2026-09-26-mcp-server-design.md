# ClientRecord MCP server — design

**Status:** Approved 2026-09-26 · **Owner:** tcusworth@gmail.com

## Goal

Let a team member's AI tool (Claude.ai / Claude app, Claude Code / Claude Desktop, ChatGPT) read the CRM and make safe changes, acting as that person with that person's current permissions.

## Decisions

| Topic | Decision |
|---|---|
| Protocol | Remote MCP over Streamable HTTP (stateless) at `https://mcp.clientrecordcrm.com/mcp` |
| Hosting | Separate Worker `clientrecord-mcp` in this repo (own `mcp/wrangler.jsonc`), bound to the same D1 database `clientrecord-crm-db` |
| Auth | OAuth 2.1 via `@cloudflare/workers-oauth-provider` (dynamic client registration, PKCE, refresh tokens); token store in a KV namespace `OAUTH_KV` |
| Identity | Cloudflare Access (existing team `tcusworth.cloudflareaccess.com`) on the `/authorize` and `/connections` pages; JWT verified with `lib/cloudflare-access.ts` |
| Identity model | Each person connects as themselves; the AI gets exactly that person's role/permissions |
| Powers | Read + safe writes. No delete, merge, bulk edit, email/campaign send, import, settings, team or document access |
| Out of scope (v1) | Documents, sending email, deletes, API-key (non-OAuth) access, REST/OpenAPI for GPT Actions |

## Architecture

```
Claude / ChatGPT ──OAuth──▶ mcp.clientrecordcrm.com
                              ├─ /.well-known/*, /register, /token   (public; OAuth library)
                              ├─ /authorize, /connections            (behind Cloudflare Access)
                              └─ /mcp                                (bearer token; MCP tools)
                                        │
                                        ▼
                              shared lib/ (crm-records, crm-auth, services/*)
                                        │
                                        ▼
                              D1 clientrecord-crm-db (same database as the CRM)
```

- `mcp/src/index.ts` exports `new OAuthProvider({ apiRoute: "/mcp", apiHandler, defaultHandler, authorizeEndpoint: "/authorize", tokenEndpoint: "/token", clientRegistrationEndpoint: "/register" })`.
- `apiHandler` uses the stateless MCP handler (`createMcpHandler` from Cloudflare's agents SDK, or the MCP TypeScript SDK's web-standard Streamable HTTP transport, whichever the build plan verifies works on this toolchain).
- `defaultHandler` serves `/authorize` (consent) and `/connections` (list/revoke grants).
- Shared code: tools call the same functions the CRM routes call. Business rules currently inline in route handlers (deal stage validation and stage history in `app/api/sales/route.ts` `saveDeal`; contact create/update with duplicate + suppression checks and company reconciliation in `app/api/crm/route.ts`; notes/activities in `app/api/deal-workspace/route.ts`; tasks in `app/api/crm` and `app/api/sales`) are extracted into `lib/services/*` functions used by both the CRM routes and the MCP tools. CRM behaviour must not change (existing tests are the guard).

## Sign-in flow

1. Client registers dynamically (`/register`) and starts OAuth with PKCE at `/authorize`.
2. `/authorize` sits behind Cloudflare Access. The handler verifies the `Cf-Access-Jwt-Assertion` (team domain + this application's AUD), then resolves the person: owner (`CRM_ALLOWED_EMAILS`) or active `team_members` row. Anyone else is refused.
3. Consent page shows: client name, redirect host, signed-in email and role, and the powers ("read your CRM and make safe changes; cannot delete, merge, bulk edit or send email"). Allow → `completeAuthorization({ userId: email, props: { email } })`; Deny → error redirect.
4. Tokens: access 1 hour, refresh 30 days (library-managed, stored hashed in KV).
5. Every `/mcp` request re-resolves the person's **current** role/permissions from D1 (`crmUser`-equivalent by email). Disabled or removed members are rejected immediately; demotions apply immediately.
6. `/connections` (behind Access) lists the signed-in person's grants (client name, created) with **Disconnect** (`revokeGrant`).

Cloudflare Access configuration: add `mcp.clientrecordcrm.com/authorize` and `mcp.clientrecordcrm.com/connections` to the existing "ClientRecord CRM" application; a Bypass application covers `mcp.clientrecordcrm.com` `/mcp`, `/token`, `/register`, `/.well-known`.

## Tools

All tools take and return JSON, run as the signed-in person, enforce that person's permissions and the same validation as the app, and write audit-log entries with `via: "mcp"` and the client name.

Read (`readOnlyHint: true`):

| Tool | Behaviour |
|---|---|
| `search_crm` | Search contacts/companies/deals (reuses `lib/crm-records.ts` search) |
| `get_contact`, `get_company`, `get_deal` | Record detail + recent activity, open tasks, notes, stakeholders, linked records |
| `list_contacts`, `list_companies` | Paged lists with the app's filters (stage, tag, view, sort); max 25 per page |
| `list_deals` | Filter by stage, owner, close window, at risk |
| `list_tasks` | Mine / overdue / due soon / by record |
| `pipeline_summary` | Totals by stage, weighted forecast, stalled deals |

Write (`readOnlyHint: false`, `destructiveHint: false`):

| Tool | Behaviour |
|---|---|
| `create_contact`, `update_contact` | Duplicate-email and suppression checks; company reconciliation |
| `create_company`, `update_company` | Same validation as the Companies screen |
| `create_deal`, `update_deal` | Pipeline/stage rules and required fields; stage history |
| `add_note` | Note on a contact, company or deal |
| `log_activity` | Call/meeting/email that happened, on a contact or deal |
| `create_task`, `complete_task` | Follow-ups |

Permission mapping: read tools need `records.view`; write tools need `records.edit`. Owner passes everything; viewers get read tools only (write tools return a permission error).

## Safety

- Tool results are structured data; long free-text fields are truncated; results carry no instructions. Tools never act on text inside records.
- Never returned: sensitive documents or their titles, proposal share tokens, API keys, webhook secrets, integration tokens, settings.
- Errors are explicit MCP tool errors: permission denied, not found, validation message.
- Rate limit: ~60 tool calls per minute per person (`lib/rate-limit.ts`).
- Audit log: every write, attributed to the person with `via: "mcp"` and client name; webhooks fire as for app changes.

## Testing

- Service extraction: existing `pnpm test` suite passes unchanged; new unit tests for each extracted service function.
- Tools: each tool tested as owner, editor and viewer (allowed/blocked, validation, audit entry, no sensitive fields), using the existing in-memory D1 test harness.
- OAuth/consent: registration, consent allow/deny, token exchange, rejected after Disconnect, rejection when the member is disabled, identity only from a verified Access JWT.
- End-to-end locally: run the MCP Worker with `wrangler dev` and connect Claude Code (and MCP Inspector) for a few read and write requests before deploying.

## Rollout

1. `wrangler kv namespace create OAUTH_KV` (id goes into `mcp/wrangler.jsonc`).
2. Cloudflare Access: add the MCP hostname paths to the existing app; create the bypass app for the token/MCP paths.
3. `pnpm run deploy` deploys the CRM and the MCP Worker (MCP Worker secrets: `CF_ACCESS_AUD`, `CRM_ALLOWED_EMAILS`).
4. Connect: Claude (Settings → Connectors → add custom connector), Claude Code (`claude mcp add --transport http clientrecord https://mcp.clientrecordcrm.com/mcp`), ChatGPT (custom connector).
