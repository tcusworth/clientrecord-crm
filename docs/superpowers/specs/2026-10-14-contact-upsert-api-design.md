# Contact upsert API for website forms — design

**Status:** Approved in conversation 2026-10-14 · **Owner:** trevor.cusworth@csi-automation.com

## Goal

Replace the Attio integration used by the CSI website. The site's forms are the contact form, EPC inquiry, report download, decoder and Insights signup. One server-side call per submission upserts the contact, records the source and attribution as structured data, adds a note, joins named lists, and returns status codes that let the caller tell a bad payload (4xx) from a retryable failure (5xx).

## Owner requirements (verbatim intent)

1. Upsert by email. The call is idempotent, returns the contact ID, and says whether the contact was created or updated.
2. Blank values never overwrite existing values.
3. Contact fields: first name, last name, full name, job title, and company as free text.
4. A note (title plus plain-text body) is added in the same call.
5. A source that tells apart contact form, EPC inquiry, report download, decoder and Insights signup, plus the report name for downloads.
6. Attribution as structured, filterable fields: consent, referrer and UTM.
7. List membership by name. A missing list is created, and adding a contact is idempotent, e.g. "State of OPA 2026".
8. Plain HTTP status codes: 4xx for a bad payload, 5xx for retry.

## Decisions

| Topic | Decision |
|---|---|
| Endpoint | New `POST /api/v1/contacts/upsert`. The existing `/api/lead-capture` is unchanged. |
| Auth | Existing API-key scope `leads.capture` (`Authorization: Bearer cr_live_…`). `/api/v1/*` is already on the Access bypass list. |
| Tasks | Only `contact_form` and `epc_inquiry` create a "Respond to {name} · {source}" task. |
| Attribution storage | Every submission is stored as a row with structured columns. The contact keeps a first source (set once) and a latest source (updated every time). |
| Consent | Consent controls subscription. Details in Behaviour step 4. |
| Lists | Static lists appear under Audiences with member counts, can be chosen as a campaign audience, and show on the contact record. |

## API

`POST /api/v1/contacts/upsert`, `Content-Type: application/json`, body up to 20 KB.

| Field | Type | Rules |
|---|---|---|
| `email` | string | Required. Valid address, ≤320 characters. Stored lowercased. |
| `firstName`, `lastName` | string | Optional, ≤120 characters. |
| `fullName` | string | Optional, ≤240 characters. Split on the first space and used only for whichever of first or last name is missing. |
| `jobTitle` | string | Optional, ≤200 characters. Stored in `contacts.title`. |
| `company` | string | Optional free text, ≤240 characters. Stored in `contacts.company`. It is not linked to a company record. |
| `note` | object | Optional `{ title: string ≤200, body: string ≤10000 }`. Ignored if both are blank. |
| `source` | string | Required. One of `contact_form`, `epc_inquiry`, `report_download`, `decoder`, `insights_signup`. |
| `reportName` | string | ≤200 characters. Required when `source` is `report_download`. |
| `consent` | boolean | Optional. |
| `consentText` | string | Optional, ≤1000 characters: the wording the visitor agreed to. |
| `referrer` | string | Optional, ≤2000 characters. |
| `utm` | object | Optional `{ source, medium, campaign, term, content }`, each ≤200 characters. |
| `lists` | string[] | Optional, ≤10 names, each 1–120 characters. Matching is case-insensitive and trimmed. |
| `submissionId` | string | Optional but recommended. 1–200 characters, unique per form submission. Makes retries safe. |

Unknown fields are ignored. Blank strings count as absent everywhere.

### Responses

All responses are JSON.

| Status | Body | When |
|---|---|---|
| 201 | `{ contactId, action: "created", submissionId, lists: [{ id, name }] }` | A new contact was created. |
| 200 | `{ contactId, action: "updated", … }` | The contact existed. |
| 200 | `{ contactId, action: "duplicate", … }` | The `submissionId` was already processed. The first result is returned and no further writes happen. |
| 400 | `{ error, fields: { name: message } }` | Malformed JSON or a validation failure. |
| 401 | `{ error }` | API key missing or invalid. |
| 403 | `{ error }` | The key lacks `leads.capture`. |
| 413 | `{ error }` | Body over 20 KB. |
| 500 / 503 | `{ error: "Temporary failure; retry." }` | Database or unexpected error. Details are logged server-side and never returned. |

## Behaviour (one call)

1. Validate. Any error returns 4xx with no writes.
2. If `submissionId` is present and already stored, return 200 `duplicate` with the stored `contactId`.
3. Find the contact by `lower(email)`.
   - **Create:** insert with the provided fields. Stage `Lead`, tag-free, `lead_source` and `first_source` = source, `latest_source` = source.
   - **Update:** set only fields whose new value is non-blank (first name, last name, title, company), then set `latest_source`. `first_source` is filled only if empty. Never blank anything.
4. Consent:
   - New contact: subscribed when `consent === true`, otherwise unsubscribed.
   - Existing contact: `consent === true` subscribes them only if currently unsubscribed **and** not suppressed (`suppression_reason` empty, no suppression record).
   - `false` or missing never unsubscribes anyone.
5. Note: if present, a contact activity of type `Note` is added, with the text `"{title}\n\n{body}"` trimmed, via the existing `logContactActivity`.
6. Lists:
   - For each name, find a list case-insensitively or create it.
   - `INSERT OR IGNORE` the membership. The primary key is (list_id, contact_id).
7. Task: only for `contact_form` and `epc_inquiry`, a "Respond to {first name or email} · {source label}" task is created, due today, owned by the CRM owner.
8. Submission record: insert a row into `form_submissions` (columns below), including the `contactId`, the action and the task ID.
9. Audit: `audit(user, "contact.upsert", "contact", contactId, …, { source, action, submissionId, lists })`. This emits the existing webhook as other audits do.

Writes in steps 3–8 run in one D1 batch where practical. If the `submissionId` unique index rejects a concurrent duplicate, the API answers as step 2 does.

## Data (migration 0032)

- `contacts`: add `first_source TEXT NOT NULL DEFAULT ''` and `latest_source TEXT NOT NULL DEFAULT ''`. Existing `lead_source` is unchanged.
- `form_submissions`:
  - `id` (uuid text, primary key) and `submission_id` (text, nullable, unique where not null);
  - `contact_id` and `action`;
  - `source` and `report_name`;
  - `consent` (integer, nullable), `consent_text` and `referrer`;
  - `utm_source`, `utm_medium`, `utm_campaign`, `utm_term` and `utm_content`;
  - `note_title`, `lists_json` and `task_id`;
  - `api_key_id` (the caller) and `created_at`.
  - Indexes on (source), (contact_id) and (utm_campaign).
- `contact_lists`: `id`, `name` (unique, case-insensitive via `lower(name)`), `created_at`.
- `contact_list_members`: `list_id`, `contact_id`, `added_at`, `source`, with primary key (list_id, contact_id).
- Contact delete (`CONTACT_REFERENCES`) removes the contact's list memberships and detaches its form submissions.

## Screens

- **Audiences:** a new "Lists" panel. It shows each list with its member count. Opening a list shows its members, and members can be removed (records.edit permission). Lists can be renamed and deleted (owner/admin). Deleting a list removes only its memberships.
- **Campaigns:** the audience picker offers each list (`list:{id}`). Sending uses the list's members, skipping unsubscribed and suppressed contacts as today.
- **Contact record:** shows lists as chips, plus first and latest source.
- **Lead capture screen:** a "Website submissions" table shows date, contact, source, report, campaign (UTM) and consent, filterable by source.

## Errors and safety

- 4xx versus 5xx is decided only by validation and authentication. Everything thrown after validation is 500, or 503 for D1 overload or timeout. A retry with the same `submissionId` is safe.
- No secrets or internal error text appear in responses.
- The endpoint is API-key only. A signed-in browser session cannot use it. It is never meant to be called from a visitor's browser, so there are no CORS headers.
- The caller's API key ID is recorded on each submission.

## Out of scope

- Changing the CSI website code (the owner's side).
- Rate limiting beyond what Cloudflare provides.
- Company record linking or enrichment.
- Changes to `/api/lead-capture`.
- Bulk import of past Attio data.

## Testing

`scripts/test-contact-upsert.mjs`, using the existing harness, covers:
- **Create and update:** create (201) versus update (200); blanks never overwrite; `fullName` split; first source versus latest source.
- **Idempotency:** a repeated `submissionId` returns `duplicate` with no new note, task, list row or submission.
- **Lists:** a list is created once, case-insensitively; membership is idempotent.
- **Consent:** all four rules, including a suppressed contact staying unsubscribed.
- **Tasks:** created only for `contact_form` and `epc_inquiry`.
- **Status codes:** every 4xx, including missing `reportName`, a bad source, 401, 403 and 413, plus a simulated database failure returning 5xx.
- **Screens:** a list audience resolves the right recipients.
- **Docs:** OpenAPI documents the endpoint.

Lint shows 0 errors and the build passes.

## Rollout (owner)

1. Merge and deploy. The migration applies automatically.
2. In the CRM, create an API key with scope `leads.capture` for the website.
3. Update the website's server functions to call the endpoint, sending a `submissionId` per submission and treating 5xx as "show retry".
