import { env } from "cloudflare:workers";
import {
  assertAiRunAllowed,
  beginAiRun,
  completeAiRun,
  failAiRun,
  loadAiSettings,
  providerConfigured,
} from "@/lib/ai-governance";
import {
  aiFieldDefinitions,
  aiRecordResponseSchema,
  buildDeterministicAIRecordResult,
  fieldKeys,
  meddpiccDefinitions,
  normalizeAIRecordResult,
  type AIEntityType,
  type AIRecordResult,
  type EvidenceSource,
} from "@/lib/ai-record-fields";
import { audit, can, crmUser, sha256, type CRMUser } from "@/lib/crm-auth";

type Row = Record<string, unknown>;
const clean = (value: unknown, max = 4000) =>
  String(value ?? "")
    .trim()
    .slice(0, max);
const parse = (value: unknown, fallback: unknown = {}) => {
  try {
    return JSON.parse(String(value ?? ""));
  } catch {
    return fallback;
  }
};
const rows = async (sql: string, ...args: (string | number | null)[]) =>
  (
    await env.DB.prepare(sql)
      .bind(...args)
      .all()
  ).results as Row[];
const one = async (sql: string, ...args: (string | number | null)[]) =>
  env.DB.prepare(sql)
    .bind(...args)
    .first<Row>();
const denied = (
  user: CRMUser | null,
  permission: "ai.view" | "ai.generate" | "ai.review" | "records.edit",
) =>
  !user
    ? Response.json({ error: "Sign in is required." }, { status: 401 })
    : !can(user, permission)
      ? Response.json(
          { error: `${permission} permission is required.` },
          { status: 403 },
        )
      : null;
const entityType = (value: unknown) => {
  const result = clean(value, 20) as AIEntityType;
  if (!["company", "contact", "deal"].includes(result))
    throw new Error("Choose a company, contact, or deal.");
  return result;
};
const entityId = (value: unknown) => {
  const result = Number(value);
  if (!Number.isInteger(result) || result < 1)
    throw new Error("Choose a valid record.");
  return result;
};
const confidenceNumber = (value: string) =>
  value === "High" ? 90 : value === "Medium" ? 70 : 40;
const confidenceLabel = (value: unknown) =>
  Number(value) >= 85 ? "High" : Number(value) >= 60 ? "Medium" : "Low";
const feature = (type: AIEntityType) => `record-fields-${type}`;
const promptFeature = (type: AIEntityType) =>
  type === "company"
    ? "account-summary"
    : type === "contact"
      ? "contact-persona"
      : "meddpicc";

function source(
  sourceType: string,
  sourceId: unknown,
  label: unknown,
  content: unknown,
  occurredAt: unknown,
  updatedAt: unknown,
): EvidenceSource {
  const text = clean(content, 10000),
    date = clean(occurredAt || updatedAt, 50);
  return {
    sourceType,
    sourceId: String(sourceId),
    label: clean(label, 240),
    excerpt: text.slice(0, 500),
    occurredAt: date,
    updatedAt: clean(updatedAt || occurredAt, 50),
    content: text,
  };
}
function artifact(row: Row | null) {
  if (!row) return null;
  return {
    id: row.id,
    reviewStatus: row.review_status,
    content: normalizeAIRecordResult(
      parse(row.content_json),
      String(row.entity_type) as AIEntityType,
    ),
    explanation: row.explanation,
    confidence: confidenceLabel(row.confidence),
    provider: row.provider,
    model: row.model,
    promptVersion: row.prompt_version,
    rulesVersion: row.rules_version,
    generatedBy: row.generated_by,
    generatedAt: row.generated_at,
    reviewedBy: row.reviewed_by,
    reviewedAt: row.reviewed_at,
    sourceCount: Number(row.source_count || 0),
  };
}
function materialized(row: Row) {
  return {
    id: row.id,
    fieldKey: row.field_key,
    value: parse(row.value_json, ""),
    explanation: row.explanation,
    confidence: confidenceLabel(row.confidence),
    citations: parse(row.citations_json, []),
    sourceArtifactId: row.source_artifact_id,
    manualOverride: Boolean(row.manual_override),
    locked: Boolean(row.locked),
    updatedBy: row.updated_by,
    updatedAt: row.updated_at,
  };
}

async function context(type: AIEntityType, id: number) {
  if (type === "company") {
    const record = await one("SELECT * FROM companies WHERE id=?", id);
    if (!record) throw new Error("Company not found.");
    const [
      contacts,
      stakeholders,
      signals,
      deals,
      activities,
      notes,
      meetings,
    ] = await Promise.all([
      rows(
        "SELECT * FROM contacts WHERE lower(company)=lower(?) OR id=? ORDER BY updated_at DESC",
        clean(record.name, 240),
        Number(record.primary_contact_id || 0),
      ),
      rows(
        "SELECT s.*,c.first_name||' '||c.last_name AS contact_name,c.title FROM account_stakeholders s JOIN contacts c ON c.id=s.contact_id WHERE s.company_id=?",
        id,
      ),
      rows(
        "SELECT * FROM account_signals WHERE company_id=? AND active=1 ORDER BY occurred_at DESC",
        id,
      ),
      rows(
        "SELECT * FROM deals WHERE company_id=? OR lower(company)=lower(?) ORDER BY updated_at DESC",
        id,
        clean(record.name, 240),
      ),
      rows(
        "SELECT a.* FROM deal_activities a JOIN deals d ON d.id=a.deal_id WHERE a.company_id=? OR d.company_id=? ORDER BY a.happened_at DESC LIMIT 80",
        id,
        id,
      ),
      rows(
        "SELECT n.* FROM deal_notes n JOIN deals d ON d.id=n.deal_id WHERE d.company_id=? ORDER BY n.created_at DESC LIMIT 60",
        id,
      ),
      rows(
        "SELECT m.* FROM deal_meetings m JOIN deals d ON d.id=m.deal_id WHERE m.company_id=? OR d.company_id=? ORDER BY m.starts_at DESC LIMIT 50",
        id,
        id,
      ),
    ]);
    const sources = [
      source(
        "company",
        id,
        record.name,
        JSON.stringify(record),
        record.updated_at,
        record.updated_at,
      ),
      ...contacts.map((r) =>
        source(
          "contact",
          r.id,
          `${clean(r.first_name)} ${clean(r.last_name)}`,
          JSON.stringify(r),
          r.last_contact,
          r.updated_at,
        ),
      ),
      ...stakeholders.map((r) =>
        source(
          "stakeholder",
          r.id,
          `${clean(r.contact_name)} · ${clean(r.role)}`,
          `${clean(r.role)} ${clean(r.notes)} ${clean(r.title)}`,
          r.updated_at,
          record.updated_at,
        ),
      ),
      ...signals.map((r) =>
        source(
          "signal",
          r.id,
          r.summary,
          `${clean(r.kind)} ${clean(r.summary)} ${clean(r.evidence)}`,
          r.occurred_at,
          r.created_at,
        ),
      ),
      ...deals.map((r) =>
        source(
          "deal",
          r.id,
          r.name,
          JSON.stringify(r),
          r.updated_at,
          r.updated_at,
        ),
      ),
      ...activities.map((r) =>
        source(
          "activity",
          r.id,
          r.subject || r.type,
          `${clean(r.type)} ${clean(r.subject)} ${clean(r.body)} ${clean(r.outcome)}`,
          r.happened_at,
          r.updated_at,
        ),
      ),
      ...notes.map((r) =>
        source(
          "note",
          r.id,
          `${clean(r.kind)} note`,
          r.body,
          r.created_at,
          r.updated_at,
        ),
      ),
      ...meetings.map((r) =>
        source(
          "meeting",
          r.id,
          r.subject,
          `${clean(r.summary)} ${clean(r.decisions_json)} ${clean(r.customer_commitments_json)} ${clean(r.risks_objections_json)} ${clean(r.next_steps_json)}`,
          r.starts_at,
          r.updated_at,
        ),
      ),
    ];
    return {
      record,
      sources,
      context: {
        contactCount: contacts.length,
        openDealCount: deals.filter((r) => clean(r.status) !== "Closed").length,
        activeSignalCount: signals.length,
      },
    };
  }
  if (type === "contact") {
    const record = await one("SELECT * FROM contacts WHERE id=?", id);
    if (!record) throw new Error("Contact not found.");
    const [
      company,
      activities,
      dealActivities,
      accountStakeholders,
      dealStakeholders,
      meetings,
      deals,
    ] = await Promise.all([
      one(
        "SELECT * FROM companies WHERE lower(name)=lower(?) OR primary_contact_id=? ORDER BY primary_contact_id=? DESC LIMIT 1",
        clean(record.company, 240),
        id,
        id,
      ),
      rows(
        "SELECT * FROM activities WHERE contact_id=? ORDER BY happened_at DESC LIMIT 60",
        id,
      ),
      rows(
        "SELECT * FROM deal_activities WHERE contact_id=? ORDER BY happened_at DESC LIMIT 80",
        id,
      ),
      rows(
        "SELECT s.*,co.name AS company_name FROM account_stakeholders s JOIN companies co ON co.id=s.company_id WHERE s.contact_id=?",
        id,
      ),
      rows(
        "SELECT s.*,d.name AS deal_name FROM deal_stakeholders s JOIN deals d ON d.id=s.deal_id WHERE s.contact_id=? AND s.active=1",
        id,
      ),
      rows(
        "SELECT m.*,a.role AS attendee_role FROM deal_meeting_attendees a JOIN deal_meetings m ON m.id=a.meeting_id WHERE a.contact_id=? ORDER BY m.starts_at DESC LIMIT 50",
        id,
      ),
      rows(
        "SELECT DISTINCT d.* FROM deals d LEFT JOIN deal_stakeholders s ON s.deal_id=d.id WHERE d.contact_id=? OR s.contact_id=? ORDER BY d.updated_at DESC",
        id,
        id,
      ),
    ]);
    const sources = [
      source(
        "contact",
        id,
        `${clean(record.first_name)} ${clean(record.last_name)}`,
        JSON.stringify(record),
        record.last_contact,
        record.updated_at,
      ),
      ...(company
        ? [
            source(
              "company",
              company.id,
              company.name,
              JSON.stringify(company),
              company.updated_at,
              company.updated_at,
            ),
          ]
        : []),
      ...activities.map((r) =>
        source(
          "activity",
          r.id,
          r.type,
          `${clean(r.type)} ${clean(r.note)}`,
          r.happened_at,
          r.happened_at,
        ),
      ),
      ...dealActivities.map((r) =>
        source(
          "activity",
          `deal-${r.id}`,
          r.subject || r.type,
          `${clean(r.type)} ${clean(r.subject)} ${clean(r.body)} ${clean(r.outcome)}`,
          r.happened_at,
          r.updated_at,
        ),
      ),
      ...accountStakeholders.map((r) =>
        source(
          "stakeholder",
          `account-${r.id}`,
          `${clean(r.company_name)} · ${clean(r.role)}`,
          `${clean(r.role)} ${clean(r.notes)}`,
          r.updated_at,
          record.updated_at,
        ),
      ),
      ...dealStakeholders.map((r) =>
        source(
          "stakeholder",
          `deal-${r.id}`,
          `${clean(r.deal_name)} · ${clean(r.role)}`,
          `${clean(r.role)} ${clean(r.notes)}`,
          r.updated_at,
          r.updated_at,
        ),
      ),
      ...meetings.map((r) =>
        source(
          "meeting",
          r.id,
          r.subject,
          `${clean(r.summary)} ${clean(r.decisions_json)} ${clean(r.customer_commitments_json)} ${clean(r.risks_objections_json)} ${clean(r.next_steps_json)}`,
          r.starts_at,
          r.updated_at,
        ),
      ),
      ...deals.map((r) =>
        source(
          "deal",
          r.id,
          r.name,
          JSON.stringify(r),
          r.updated_at,
          r.updated_at,
        ),
      ),
    ];
    return {
      record,
      sources,
      context: {
        activityCount: activities.length + dealActivities.length,
        dealCount: deals.length,
      },
    };
  }
  const record = await one("SELECT * FROM deals WHERE id=?", id);
  if (!record) throw new Error("Deal not found.");
  const [
    company,
    activities,
    notes,
    stakeholders,
    meetings,
    risks,
    tasks,
    recommendation,
    proposals,
    reviews,
  ] = await Promise.all([
    record.company_id
      ? one("SELECT * FROM companies WHERE id=?", Number(record.company_id))
      : one(
          "SELECT * FROM companies WHERE lower(name)=lower(?)",
          clean(record.company, 240),
        ),
    rows(
      "SELECT * FROM deal_activities WHERE deal_id=? ORDER BY happened_at DESC LIMIT 100",
      id,
    ),
    rows(
      "SELECT * FROM deal_notes WHERE deal_id=? ORDER BY pinned DESC,created_at DESC LIMIT 80",
      id,
    ),
    rows(
      "SELECT s.*,c.first_name||' '||c.last_name AS contact_name,c.title,c.email FROM deal_stakeholders s JOIN contacts c ON c.id=s.contact_id WHERE s.deal_id=? AND s.active=1",
      id,
    ),
    rows(
      "SELECT * FROM deal_meetings WHERE deal_id=? ORDER BY starts_at DESC LIMIT 60",
      id,
    ),
    rows(
      "SELECT * FROM deal_insights WHERE deal_id=? AND status='Open' ORDER BY updated_at DESC",
      id,
    ),
    rows(
      "SELECT * FROM deal_tasks WHERE deal_id=? ORDER BY completed,due_date",
      id,
    ),
    one(
      "SELECT * FROM deal_recommendations WHERE deal_id=? AND status='Active' ORDER BY generated_at DESC LIMIT 1",
      id,
    ),
    rows(
      "SELECT * FROM deal_proposals WHERE deal_id=? ORDER BY updated_at DESC",
      id,
    ),
    rows(
      "SELECT * FROM deal_reviews WHERE deal_id=? ORDER BY requested_at DESC",
      id,
    ),
  ]);
  const sources = [
    source(
      "deal",
      id,
      record.name,
      JSON.stringify(record),
      record.updated_at,
      record.updated_at,
    ),
    ...(company
      ? [
          source(
            "company",
            company.id,
            company.name,
            JSON.stringify(company),
            company.updated_at,
            company.updated_at,
          ),
        ]
      : []),
    ...activities.map((r) =>
      source(
        "activity",
        r.id,
        r.subject || r.type,
        `${clean(r.type)} ${clean(r.subject)} ${clean(r.body)} ${clean(r.outcome)}`,
        r.happened_at,
        r.updated_at,
      ),
    ),
    ...notes.map((r) =>
      source(
        "note",
        r.id,
        `${clean(r.kind)} note`,
        r.body,
        r.created_at,
        r.updated_at,
      ),
    ),
    ...stakeholders.map((r) =>
      source(
        "stakeholder",
        r.id,
        `${clean(r.contact_name)} · ${clean(r.role)}`,
        `${clean(r.role)} ${clean(r.notes)} ${clean(r.title)}`,
        r.updated_at,
        r.updated_at,
      ),
    ),
    ...meetings.map((r) =>
      source(
        "meeting",
        r.id,
        r.subject,
        `${clean(r.summary)} ${clean(r.decisions_json)} ${clean(r.customer_commitments_json)} ${clean(r.internal_commitments_json)} ${clean(r.risks_objections_json)} ${clean(r.next_steps_json)}`,
        r.starts_at,
        r.updated_at,
      ),
    ),
    ...risks.map((r) =>
      source(
        "risk",
        r.id,
        r.title,
        `${clean(r.kind)} ${clean(r.title)} ${clean(r.detail)} ${clean(r.severity)}`,
        r.updated_at,
        r.updated_at,
      ),
    ),
    ...tasks.map((r) =>
      source(
        "task",
        r.id,
        r.title,
        JSON.stringify(r),
        r.due_date,
        r.created_at,
      ),
    ),
    ...(recommendation
      ? [
          source(
            "recommendation",
            recommendation.id,
            recommendation.action,
            `${clean(recommendation.action)} ${clean(recommendation.reason)} ${clean(recommendation.evidence_json)}`,
            recommendation.generated_at,
            recommendation.updated_at,
          ),
        ]
      : []),
    ...proposals.map((r) =>
      source(
        "proposal",
        r.id,
        r.title,
        JSON.stringify(r),
        r.valid_until,
        r.updated_at,
      ),
    ),
    ...reviews.map((r) =>
      source(
        "review",
        r.id,
        r.review_type,
        JSON.stringify(r),
        r.requested_at,
        r.decided_at || r.requested_at,
      ),
    ),
  ];
  return {
    record,
    sources,
    context: {
      overdueTaskCount: tasks.filter(
        (r) =>
          !r.completed &&
          clean(r.due_date) < new Date().toISOString().slice(0, 10),
      ).length,
      recommendedNextAction: recommendation?.action || record.next_step,
    },
  };
}

function outputText(response: Row) {
  if (typeof response.output_text === "string") return response.output_text;
  const output = Array.isArray(response.output) ? response.output : [];
  return output
    .flatMap((item) =>
      Array.isArray((item as Row).content)
        ? ((item as Row).content as Row[])
        : [],
    )
    .map((item) => (item.type === "output_text" ? clean(item.text, 50000) : ""))
    .join("");
}
async function modelResult(
  input: string,
  type: AIEntityType,
  settings: Row,
  prompt: Row | null,
  sources: EvidenceSource[],
) {
  const key = clean(
      (env as unknown as Record<string, unknown>).OPENAI_API_KEY,
      1000,
    ),
    system =
      clean(prompt?.system_prompt, 30000) ||
      "Classify CRM record fields using only supplied ClientRecord evidence. Never invent facts. Cite sourceType and sourceId exactly as supplied. MEDDPICC Partial or Confirmed classifications require a citation to an activity, note, stakeholder, or meeting. Use Unknown when evidence is absent.";
  const response = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      authorization: `Bearer ${key}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model: String(settings.model),
      input: [
        { role: "system", content: system },
        { role: "user", content: input },
      ],
      max_output_tokens: 3500,
      text: {
        format: {
          type: "json_schema",
          name: `clientrecord_${type}_record_fields`,
          strict: true,
          schema: aiRecordResponseSchema(type),
        },
      },
    }),
  });
  const payload = (await response.json()) as Row;
  if (!response.ok)
    throw new Error(
      clean((payload.error as Row | undefined)?.message, 1200) ||
        `AI provider returned ${response.status}.`,
    );
  const text = outputText(payload);
  if (!text) throw new Error("The AI provider returned no record fields.");
  return normalizeAIRecordResult(JSON.parse(text), type, sources);
}

async function generate(
  type: AIEntityType,
  id: number,
  user: CRMUser,
  force: boolean,
) {
  const settings = await loadAiSettings(),
    bundle = await context(type, id),
    prompt = await one(
      "SELECT * FROM ai_prompt_versions WHERE feature=? AND status='Active' ORDER BY version DESC LIMIT 1",
      promptFeature(type),
    ),
    maxChars = Number(settings.maxContextChars || 60000),
    safeSources = bundle.sources.slice(0, 250),
    input = JSON.stringify({
      instruction:
        "Classify the requested record fields from these CRM sources only.",
      entityType: type,
      record: bundle.record,
      context: bundle.context,
      sources: safeSources,
    }).slice(0, maxChars),
    providerMode = Boolean(settings.enabled) && providerConfigured(),
    hashInput = JSON.stringify({
      input,
      promptVersion: Number(prompt?.version || 1),
      model: providerMode ? settings.model : "record-fields-rules-v1",
    }),
    inputHash = await sha256(hashInput);
  if (!force) {
    const cached = await one(
      "SELECT a.*,(SELECT count(*) FROM ai_artifact_sources s WHERE s.artifact_id=a.id) AS source_count FROM ai_artifacts a WHERE a.feature=? AND a.entity_type=? AND a.entity_id=? AND a.input_hash=? AND a.review_status!='Rejected' AND a.superseded_by IS NULL ORDER BY a.generated_at DESC LIMIT 1",
      feature(type),
      type,
      String(id),
      inputHash,
    );
    if (cached)
      return {
        artifact: artifact(cached),
        cached: true,
        mode:
          String(cached.provider) === "openai"
            ? "Model-backed"
            : "Source-backed",
      };
  }
  let result: AIRecordResult,
    run: null | { id: string; startedAt: number } = null,
    provider = "clientrecord",
    model = "record-fields-rules-v1";
  if (providerMode) {
    const allowed = await assertAiRunAllowed(user);
    provider = String(allowed.provider);
    model = String(allowed.model);
    run = await beginAiRun({
      feature: feature(type),
      entityType: type,
      entityId: id,
      requestedBy: user.email,
      provider,
      model,
      promptVersion: Number(prompt?.version || 1),
      sourceCount: safeSources.length,
      input: hashInput,
    });
    try {
      result = await modelResult(input, type, allowed, prompt, safeSources);
      await completeAiRun(run, JSON.stringify(result));
    } catch (error) {
      await failAiRun(run, error);
      throw error;
    }
  } else
    result = buildDeterministicAIRecordResult({
      entityType: type,
      record: bundle.record,
      sources: safeSources,
      context: bundle.context,
    });
  const artifactId = crypto.randomUUID(),
    generatedAt = new Date().toISOString(),
    hashed = await Promise.all(
      safeSources.map(async (item) => ({
        ...item,
        hash: await sha256(item.content),
      })),
    );
  await env.DB.batch([
    env.DB.prepare(
      "UPDATE ai_artifacts SET superseded_by=? WHERE feature=? AND entity_type=? AND entity_id=? AND superseded_by IS NULL",
    ).bind(artifactId, feature(type), type, String(id)),
    env.DB.prepare(
      "INSERT INTO ai_artifacts(id,run_id,feature,entity_type,entity_id,review_status,content_json,original_content_json,explanation,confidence,provider,model,prompt_version,rules_version,input_hash,generated_by,generated_at) VALUES (?,?,?,?,?,'Draft',?,?,?,?,?,?,?,?,?,?,?)",
    ).bind(
      artifactId,
      run?.id || null,
      feature(type),
      type,
      String(id),
      JSON.stringify(result),
      JSON.stringify(result),
      result.explanation,
      confidenceNumber(result.confidence),
      provider,
      model,
      Number(prompt?.version || 1),
      "record-fields-v1",
      inputHash,
      user.email,
      generatedAt,
    ),
    ...hashed.map((item) =>
      env.DB.prepare(
        "INSERT INTO ai_artifact_sources(artifact_id,source_type,source_id,source_updated_at,content_hash,excerpt) VALUES (?,?,?,?,?,?)",
      ).bind(
        artifactId,
        item.sourceType,
        item.sourceId.slice(0, 1000),
        item.updatedAt || null,
        item.hash,
        item.excerpt.slice(0, 1000),
      ),
    ),
  ]);
  await audit(
    user,
    "ai.record_fields.generate",
    "ai_artifact",
    artifactId,
    `Generated reviewable ${type} record fields`,
    {
      entityType: type,
      entityId: id,
      provider,
      model,
      promptVersion: Number(prompt?.version || 1),
      sourceCount: safeSources.length,
    },
  );
  return {
    artifact: artifact(
      await one(
        "SELECT a.*,(SELECT count(*) FROM ai_artifact_sources s WHERE s.artifact_id=a.id) AS source_count FROM ai_artifacts a WHERE a.id=?",
        artifactId,
      ),
    ),
    cached: false,
    mode: provider === "openai" ? "Model-backed" : "Source-backed",
  };
}

async function applyAccepted(
  type: AIEntityType,
  id: number,
  artifactId: string,
  result: AIRecordResult,
  user: CRMUser,
) {
  const statements = [],
    skipped: string[] = [];
  for (const key of fieldKeys(type)) {
    const existing = await one(
      "SELECT locked FROM ai_record_fields WHERE entity_type=? AND entity_id=? AND field_key=?",
      type,
      String(id),
      key,
    );
    if (Boolean(existing?.locked)) {
      skipped.push(key);
      continue;
    }
      const value = key.startsWith("meddpicc.")
        ? result.meddpicc[key.slice(9)]?.status || "Unknown"
        : result.fields[key]?.value || "",
      detail = key.startsWith("meddpicc.")
        ? result.meddpicc[key.slice(9)]
        : result.fields[key],
      recordId = crypto.randomUUID();
    statements.push(
      env.DB.prepare(
        "INSERT INTO ai_record_fields(id,entity_type,entity_id,field_key,value_json,explanation,confidence,citations_json,source_artifact_id,manual_override,locked,updated_by,updated_at) VALUES (?,?,?,?,?,?,?,?,?,0,0,?,datetime('now')) ON CONFLICT(entity_type,entity_id,field_key) DO UPDATE SET value_json=excluded.value_json,explanation=excluded.explanation,confidence=excluded.confidence,citations_json=excluded.citations_json,source_artifact_id=excluded.source_artifact_id,manual_override=0,updated_by=excluded.updated_by,updated_at=excluded.updated_at WHERE ai_record_fields.locked=0",
      ).bind(
        recordId,
        type,
        String(id),
        key,
        JSON.stringify(value),
        detail?.explanation || "",
        confidenceNumber(
          "confidence" in (detail || {})
            ? String((detail as { confidence: string }).confidence)
            : result.confidence,
        ),
        JSON.stringify(detail?.citations || []),
        artifactId,
        user.email,
      ),
    );
  }
  if (statements.length) await env.DB.batch(statements);
  return skipped;
}

export async function GET(request: Request) {
  const user = await crmUser(request),
    error = denied(user, "ai.view");
  if (error || !user) return error;
  try {
    const url = new URL(request.url),
      type = entityType(url.searchParams.get("entityType")),
      id = entityId(url.searchParams.get("entityId"));
    await context(type, id);
    const [stored, latest, settings] = await Promise.all([
      rows(
        "SELECT * FROM ai_record_fields WHERE entity_type=? AND entity_id=? ORDER BY field_key",
        type,
        String(id),
      ),
      one(
        "SELECT a.*,(SELECT count(*) FROM ai_artifact_sources s WHERE s.artifact_id=a.id) AS source_count FROM ai_artifacts a WHERE a.feature=? AND a.entity_type=? AND a.entity_id=? AND a.superseded_by IS NULL ORDER BY a.generated_at DESC LIMIT 1",
        feature(type),
        type,
        String(id),
      ),
      loadAiSettings(),
    ]);
    return Response.json({
      entityType: type,
      entityId: id,
      definitions: aiFieldDefinitions[type],
      meddpiccDefinitions: type === "deal" ? meddpiccDefinitions : [],
      fields: stored.map(materialized),
      artifact: artifact(latest),
      providerConfigured: providerConfigured(),
      settings,
      permissions: {
        generate: can(user, "ai.generate"),
        review: can(user, "ai.review"),
        edit: can(user, "records.edit"),
      },
    });
  } catch (error) {
    return Response.json(
      {
        error:
          error instanceof Error
            ? error.message
            : "AI record fields could not load.",
      },
      { status: 400 },
    );
  }
}

export async function POST(request: Request) {
  const user = await crmUser(request);
  if (!user)
    return Response.json({ error: "Sign in is required." }, { status: 401 });
  try {
    const body = (await request.json()) as Row,
      action = clean(body.action, 40),
      type = entityType(body.entityType),
      id = entityId(body.entityId);
    await context(type, id);
    if (action === "generate") {
      const error = denied(user, "ai.generate");
      if (error) return error;
      return Response.json(await generate(type, id, user, Boolean(body.force)));
    }
    if (action === "review") {
      const error = denied(user, "ai.review");
      if (error) return error;
      const artifactId = clean(body.artifactId, 120),
        status = clean(body.status, 20);
      if (!["Accepted", "Rejected"].includes(status))
        throw new Error("Choose accepted or rejected.");
      const record = await one(
        "SELECT * FROM ai_artifacts WHERE id=? AND feature=? AND entity_type=? AND entity_id=?",
        artifactId,
        feature(type),
        type,
        String(id),
      );
      if (!record) throw new Error("AI record-field result not found.");
      const result = normalizeAIRecordResult(parse(record.content_json), type),
        before = { reviewStatus: record.review_status },
        skipped =
          status === "Accepted"
            ? await applyAccepted(type, id, artifactId, result, user)
            : [];
      await env.DB.batch([
        env.DB.prepare(
          "INSERT INTO ai_feedback_events(artifact_id,action,before_json,after_json,comment,actor,created_at) VALUES (?,?,?,?,?,?,datetime('now'))",
        ).bind(
          artifactId,
          status,
          JSON.stringify(before),
          JSON.stringify({
            reviewStatus: status,
            skippedLockedFields: skipped,
          }),
          clean(body.comment, 4000),
          user.email,
        ),
        env.DB.prepare(
          "UPDATE ai_artifacts SET review_status=?,reviewed_by=?,reviewed_at=datetime('now') WHERE id=?",
        ).bind(status, user.email, artifactId),
      ]);
      await audit(
        user,
        "ai.record_fields.review",
        "ai_artifact",
        artifactId,
        `${status} ${type} record fields`,
        {
          entityType: type,
          entityId: id,
          before,
          after: { reviewStatus: status },
          skippedLockedFields: skipped,
        },
      );
      return Response.json({ ok: true, skipped });
    }
    if (action === "saveField") {
      const error = denied(user, "ai.review") || denied(user, "records.edit");
      if (error) return error;
      const key = clean(body.fieldKey, 120);
      if (!fieldKeys(type).includes(key as never))
        throw new Error("Unknown AI record field.");
      const value = clean(body.value, 12000);
      if (
        key.startsWith("meddpicc.") &&
        !["Unknown", "Partial", "Confirmed"].includes(value)
      )
        throw new Error("Choose Unknown, Partial, or Confirmed.");
      const explanation = clean(body.explanation, 4000),
        locked = Boolean(body.locked),
        existing = await one(
          "SELECT * FROM ai_record_fields WHERE entity_type=? AND entity_id=? AND field_key=?",
          type,
          String(id),
          key,
        ),
        recordId = clean(existing?.id, 120) || crypto.randomUUID();
      await env.DB.prepare(
        "INSERT INTO ai_record_fields(id,entity_type,entity_id,field_key,value_json,explanation,confidence,citations_json,source_artifact_id,manual_override,locked,updated_by,updated_at) VALUES (?,?,?,?,?,?,100,'[]',NULL,1,?,?,datetime('now')) ON CONFLICT(entity_type,entity_id,field_key) DO UPDATE SET value_json=excluded.value_json,explanation=excluded.explanation,confidence=100,citations_json='[]',source_artifact_id=NULL,manual_override=1,locked=excluded.locked,updated_by=excluded.updated_by,updated_at=excluded.updated_at",
      )
        .bind(
          recordId,
          type,
          String(id),
          key,
          JSON.stringify(value),
          explanation,
          locked ? 1 : 0,
          user.email,
        )
        .run();
      await audit(
        user,
        "ai.record_fields.manual_update",
        type,
        id,
        `Updated and ${locked ? "locked" : "unlocked"} ${key}`,
        {
          fieldKey: key,
          before: existing ? materialized(existing) : null,
          after: { value, explanation, locked, manualOverride: true },
        },
      );
      return Response.json({ ok: true });
    }
    if (action === "toggleLock") {
      const error = denied(user, "ai.review");
      if (error) return error;
      const key = clean(body.fieldKey, 120),
        locked = Boolean(body.locked),
        existing = await one(
          "SELECT * FROM ai_record_fields WHERE entity_type=? AND entity_id=? AND field_key=?",
          type,
          String(id),
          key,
        );
      if (!existing)
        throw new Error("Save or accept this field before locking it.");
      await env.DB.prepare(
        "UPDATE ai_record_fields SET locked=?,updated_by=?,updated_at=datetime('now') WHERE id=?",
      )
        .bind(locked ? 1 : 0, user.email, existing.id)
        .run();
      await audit(
        user,
        "ai.record_fields.lock",
        type,
        id,
        `${locked ? "Locked" : "Unlocked"} ${key}`,
        {
          fieldKey: key,
          before: { locked: Boolean(existing.locked) },
          after: { locked },
        },
      );
      return Response.json({ ok: true });
    }
    throw new Error("Unknown AI record-field action.");
  } catch (error) {
    return Response.json(
      {
        error:
          error instanceof Error
            ? error.message
            : "The AI record-field action could not be completed.",
      },
      { status: 400 },
    );
  }
}
