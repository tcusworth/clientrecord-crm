# Meetily integration

ClientRecord accepts completed Meetily summaries and transcripts at:

`POST https://clientrecordcrm.com/api/integrations/meetily/meetings`

Authentication uses a scoped ClientRecord API key in `Authorization: Bearer cr_live_…`. Create the key from **Integrations → Meetily meeting capture**. The key is stored only as a SHA-256 hash in ClientRecord and is displayed once.

If Cloudflare Access protects `clientrecordcrm.com`, the desktop connector also sends these optional service-token headers:

- `CF-Access-Client-Id`
- `CF-Access-Client-Secret`

Create a Cloudflare Access service token and add a Service Auth allow policy to the ClientRecord Access application before testing the connector.

## Import behavior

- The Meetily meeting ID is the idempotency key. Repeated identical deliveries are counted but not duplicated.
- A changed delivery for the same meeting updates the existing CRM meeting.
- ClientRecord attempts to match one open deal by explicit deal ID, attendee email, company domain, then exact company name.
- Ambiguous or unmatched meetings appear in **Integrations → Meeting association queue**.
- Transcripts are stored as deal documents in private R2 object storage. Audio is never uploaded.
- The deal timeline receives a completed meeting activity, attendees, structured decisions, commitments, risks, and next steps.

## Payload contract

```json
{
  "event": "meeting.summary.updated",
  "source": "Meetily Community",
  "sentAt": "2026-09-22T12:00:00Z",
  "meeting": {
    "id": "meeting-uuid",
    "title": "Discovery call",
    "startedAt": "2026-09-22T11:00:00Z",
    "endedAt": "2026-09-22T11:45:00Z",
    "summary": "## Summary\n…",
    "summaryData": {},
    "transcript": "[00:00] …",
    "decisions": [],
    "nextSteps": [],
    "attendees": [{ "name": "Jane Doe", "email": "jane@example.com", "role": "Decision-maker" }]
  }
}
```

The receiver also accepts `customerCommitments`, `internalCommitments`, `risksAndObjections`, `companyName`, `companyDomain`, and `dealId` when available.
