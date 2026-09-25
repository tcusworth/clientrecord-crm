export type AIEntityType = "company" | "contact" | "deal";
export type AIConfidence = "Low" | "Medium" | "High";
export type Citation = {
  sourceType: string;
  sourceId: string;
  label: string;
  excerpt: string;
  occurredAt: string;
};
export type FieldResult = {
  value: string;
  explanation: string;
  confidence: AIConfidence;
  citations: Citation[];
};
export type MeddpiccStatus = "Unknown" | "Partial" | "Confirmed";
export type MeddpiccResult = {
  status: MeddpiccStatus;
  explanation: string;
  citations: Citation[];
};
export type AIRecordResult = {
  fields: Record<string, FieldResult>;
  meddpicc: Record<string, MeddpiccResult>;
  confidence: AIConfidence;
  explanation: string;
  dataGaps: string[];
};
export type EvidenceSource = Citation & { content: string; updatedAt: string };

type Row = Record<string, unknown>;
const clean = (value: unknown, max = 4000) =>
  String(value ?? "")
    .trim()
    .slice(0, max);
const confidence = (value: unknown): AIConfidence =>
  value === "High" || value === "Medium" ? value : "Low";
const status = (value: unknown): MeddpiccStatus =>
  value === "Confirmed" || value === "Partial" ? value : "Unknown";
export const aiFieldDefinitions = {
  company: [
    { key: "account-summary", label: "Account summary", kind: "text" },
    { key: "icp-tier", label: "ICP tier", kind: "short" },
    {
      key: "icp-tier-explanation",
      label: "ICP-tier explanation",
      kind: "text",
    },
  ],
  contact: [
    { key: "persona", label: "Persona", kind: "short" },
    { key: "influence-level", label: "Influence level", kind: "short" },
    {
      key: "relationship-summary",
      label: "Relationship summary",
      kind: "text",
    },
  ],
  deal: [
    {
      key: "buying-stage",
      label: "Buying-stage classification",
      kind: "short",
    },
    { key: "deal-risk-summary", label: "Deal-risk summary", kind: "text" },
    {
      key: "recommended-next-action",
      label: "Recommended next action",
      kind: "text",
    },
  ],
} as const;
export const meddpiccDefinitions = [
  { key: "metrics", label: "Metrics" },
  { key: "economic-buyer", label: "Economic buyer" },
  { key: "decision-criteria", label: "Decision criteria" },
  { key: "decision-process", label: "Decision process" },
  { key: "paper-process", label: "Paper process" },
  { key: "identify-pain", label: "Identify pain" },
  { key: "champion", label: "Champion" },
  { key: "competition", label: "Competition" },
] as const;
export const fieldKeys = (entityType: AIEntityType) => [
  ...aiFieldDefinitions[entityType].map((item) => item.key),
  ...(entityType === "deal"
    ? meddpiccDefinitions.map((item) => `meddpicc.${item.key}`)
    : []),
];

function normalizeCitation(
  value: unknown,
  allowed?: Set<string>,
): Citation | null {
  const row = (value && typeof value === "object" ? value : {}) as Row,
    sourceType = clean(row.sourceType, 80),
    sourceId = clean(row.sourceId, 200),
    key = `${sourceType}:${sourceId}`;
  if (!sourceType || !sourceId || (allowed && !allowed.has(key))) return null;
  return {
    sourceType,
    sourceId,
    label: clean(row.label, 240),
    excerpt: clean(row.excerpt, 1000),
    occurredAt: clean(row.occurredAt, 50),
  };
}
function normalizeField(value: unknown, allowed?: Set<string>): FieldResult {
  const row = (value && typeof value === "object" ? value : {}) as Row,
    citations = Array.isArray(row.citations)
      ? row.citations
          .map((item) => normalizeCitation(item, allowed))
          .filter((item): item is Citation => Boolean(item))
          .slice(0, 6)
      : [];
  return {
    value: clean(row.value, 12000),
    explanation: clean(row.explanation, 4000),
    confidence: confidence(row.confidence),
    citations,
  };
}
export function normalizeAIRecordResult(
  value: unknown,
  entityType: AIEntityType,
  sources: EvidenceSource[] = [],
): AIRecordResult {
  const row = (value && typeof value === "object" ? value : {}) as Row,
    rawFields = (
      row.fields && typeof row.fields === "object" ? row.fields : {}
    ) as Row,
    rawMeddpicc = (
      row.meddpicc && typeof row.meddpicc === "object" ? row.meddpicc : {}
    ) as Row,
    allowed = sources.length
      ? new Set(
          sources.map((source) => `${source.sourceType}:${source.sourceId}`),
        )
      : undefined,
    fields: Record<string, FieldResult> = {},
    meddpicc: Record<string, MeddpiccResult> = {};
  for (const definition of aiFieldDefinitions[entityType])
    fields[definition.key] = normalizeField(rawFields[definition.key], allowed);
  if (entityType === "deal")
    for (const definition of meddpiccDefinitions) {
      const raw = (
          rawMeddpicc[definition.key] &&
          typeof rawMeddpicc[definition.key] === "object"
            ? rawMeddpicc[definition.key]
            : {}
        ) as Row,
        citations = Array.isArray(raw.citations)
          ? raw.citations
              .map((item) => normalizeCitation(item, allowed))
              .filter(
                (item): item is Citation =>
                  Boolean(item) &&
                  ["activity", "note", "stakeholder", "meeting"].includes(
                    item!.sourceType,
                  ),
              )
              .slice(0, 6)
          : [],
        nextStatus = status(raw.status);
      meddpicc[definition.key] = {
        status:
          nextStatus !== "Unknown" && !citations.length
            ? "Unknown"
            : nextStatus,
        explanation:
          nextStatus !== "Unknown" && !citations.length
            ? "No valid activity, note, stakeholder, or meeting citation supported this classification."
            : clean(raw.explanation, 4000),
        citations,
      };
    }
  const gaps = Array.isArray(row.dataGaps)
    ? row.dataGaps
        .map((item) => clean(item, 1000))
        .filter(Boolean)
        .slice(0, 30)
    : [];
  return {
    fields,
    meddpicc,
    confidence: confidence(row.confidence),
    explanation: clean(row.explanation, 4000),
    dataGaps: gaps,
  };
}

const cite = (source: EvidenceSource): Citation => ({
  sourceType: source.sourceType,
  sourceId: source.sourceId,
  label: source.label,
  excerpt: source.excerpt,
  occurredAt: source.occurredAt,
});
const matching = (
  sources: EvidenceSource[],
  pattern: RegExp,
  types?: string[],
) =>
  sources
    .filter(
      (source) =>
        (!types || types.includes(source.sourceType)) &&
        pattern.test(source.content),
    )
    .slice(0, 4);
const field = (
  value: string,
  explanation: string,
  citations: Citation[],
  level: AIConfidence = "Medium",
): FieldResult => ({ value, explanation, confidence: level, citations });
const meddpicc = (
  matches: EvidenceSource[],
  label: string,
  strong = false,
): MeddpiccResult => ({
  status: matches.length
    ? strong || matches.length >= 2
      ? "Confirmed"
      : "Partial"
    : "Unknown",
  explanation: matches.length
    ? `${matches.length} supporting CRM record${matches.length === 1 ? "" : "s"} ${strong || matches.length >= 2 ? "confirm" : "partially support"} ${label}.`
    : `No supporting activity, note, stakeholder, or meeting currently establishes ${label}.`,
  citations: matches.map(cite),
});
const named = (record: Row, ...keys: string[]) =>
  keys.map((key) => clean(record[key], 240)).find(Boolean) || "Not recorded";

export function buildDeterministicAIRecordResult(input: {
  entityType: AIEntityType;
  record: Row;
  sources: EvidenceSource[];
  context: Row;
}): AIRecordResult {
  const { entityType, record, sources, context } = input,
    fields: Record<string, FieldResult> = {},
    meddpiccResults: Record<string, MeddpiccResult> = {},
    recordCitation = sources.find((source) => source.sourceType === entityType),
    sourceCitations = recordCitation ? [cite(recordCitation)] : [];
  if (entityType === "company") {
    const name = named(record, "name"),
      industry = named(record, "industry"),
      stage = named(record, "stage"),
      tier = clean(record.tier, 80),
      fit = Number(record.fit_score || 0),
      contacts = Number(context.contactCount || 0),
      openDeals = Number(context.openDealCount || 0),
      signals = Number(context.activeSignalCount || 0),
      summary = `${name} is a ${industry === "Not recorded" ? "company with no industry recorded" : industry + " account"} in the ${stage} lifecycle stage. It has ${contacts} contact${contacts === 1 ? "" : "s"}, ${openDeals} open deal${openDeals === 1 ? "" : "s"}, and ${signals} active buying signal${signals === 1 ? "" : "s"}.`;
    const calculated =
      tier ||
      (fit >= 80
        ? "Tier 1"
        : fit >= 60
          ? "Tier 2"
          : fit >= 40
            ? "Tier 3"
            : "Unclassified");
    fields["account-summary"] = field(
      summary,
      "Summarized from the company profile and linked CRM record counts.",
      sourceCitations,
      contacts || openDeals ? "High" : "Medium",
    );
    fields["icp-tier"] = field(
      calculated,
      tier
        ? "Used the account tier already recorded by the team."
        : `Derived from the current fit score of ${fit}/100 using ClientRecord's initial tier thresholds.`,
      sourceCitations,
      fit || tier ? "High" : "Low",
    );
    fields["icp-tier-explanation"] = field(
      tier
        ? `${name} is classified as ${tier} because that tier is set on the account record.`
        : fit
          ? `${name} has a fit score of ${fit}/100; Tier 1 starts at 80, Tier 2 at 60, and Tier 3 at 40.`
          : "No ICP tier or meaningful fit score is recorded, so the account remains unclassified.",
      "Explains the visible ICP tier without introducing external enrichment.",
      sourceCitations,
      fit || tier ? "High" : "Low",
    );
  } else if (entityType === "contact") {
    const title = clean(record.title, 240),
      name =
        `${clean(record.first_name, 120)} ${clean(record.last_name, 120)}`.trim(),
      roleSources = matching(
        sources,
        /(decision-maker|economic buyer|technical buyer|champion|blocker|influencer|legal|procurement|user)/i,
        ["stakeholder"],
      ),
      activitySources = sources.filter(
        (source) =>
          source.sourceType === "activity" || source.sourceType === "meeting",
      ),
      last = activitySources.sort((a, b) =>
        b.occurredAt.localeCompare(a.occurredAt),
      )[0];
    let persona = "Other";
    if (/chief|ceo|coo|cfo|president|vice president|\bvp\b/i.test(title))
      persona = "Executive sponsor";
    else if (/finance|budget|commercial/i.test(title))
      persona = "Economic buyer";
    else if (
      /engineer|technical|technology|architect|security|it\b/i.test(title)
    )
      persona = "Technical buyer";
    else if (/operation|plant|production|reliability|maintenance/i.test(title))
      persona = "Operations leader";
    else if (/legal|procurement|purchasing|sourcing/i.test(title))
      persona = "Legal / procurement";
    else if (/manager|director|lead/i.test(title))
      persona = "Functional leader";
    const roles = roleSources.map((source) => source.content).join(" "),
      influence = /decision-maker|economic buyer|champion/i.test(roles)
        ? "High"
        : /technical buyer|blocker|influencer|legal|procurement/i.test(roles)
          ? "Medium"
          : activitySources.length >= 3
            ? "Medium"
            : "Low";
    fields.persona = field(
      persona,
      title
        ? `Classified from the recorded title “${title}”.`
        : "No job title is recorded; persona remains broad.",
      sourceCitations,
      title ? "Medium" : "Low",
    );
    fields["influence-level"] = field(
      influence,
      roleSources.length
        ? "Based on assigned stakeholder roles across linked accounts and deals."
        : "Estimated from recorded interaction depth because no qualifying stakeholder role is assigned.",
      roleSources.map(cite),
      roleSources.length ? "High" : "Low",
    );
    fields["relationship-summary"] = field(
      `${name || "This contact"} has ${activitySources.length} recorded customer interaction${activitySources.length === 1 ? "" : "s"}${last ? `; the latest is ${last.label} on ${last.occurredAt.slice(0, 10)}` : " and no dated interaction history"}.`,
      "Summarized from contact activities, deal activities, and meeting attendance.",
      activitySources.slice(0, 3).map(cite),
      activitySources.length >= 2
        ? "High"
        : activitySources.length
          ? "Medium"
          : "Low",
    );
  } else {
    const stage = clean(record.stage, 120),
      stageText = stage.toLowerCase();
    let buyingStage = "Discovery";
    if (/prospect|lead|qualification/.test(stageText))
      buyingStage = "Problem exploration";
    else if (/discovery|scoping/.test(stageText)) buyingStage = "Discovery";
    else if (/technical|evaluation|demo|validation/.test(stageText))
      buyingStage = "Solution validation";
    else if (/proposal|quote/.test(stageText))
      buyingStage = "Commercial evaluation";
    else if (/negotiation|approval|contract/.test(stageText))
      buyingStage = "Decision and contracting";
    else if (/won|customer/.test(stageText)) buyingStage = "Purchase complete";
    else if (/lost|closed/.test(stageText))
      buyingStage = "Closed / no purchase";
    const openRisks = sources.filter((source) => source.sourceType === "risk"),
      overdue = Number(context.overdueTaskCount || 0),
      recommendation = clean(
        context.recommendedNextAction || record.next_step,
        2000,
      ),
      recent = sources
        .filter((source) => ["activity", "meeting"].includes(source.sourceType))
        .sort((a, b) => b.occurredAt.localeCompare(a.occurredAt))[0];
    fields["buying-stage"] = field(
      buyingStage,
      `Mapped from the current pipeline stage “${stage || "Not recorded"}”; this classification is separate from pipeline stage.`,
      recordCitation ? [cite(recordCitation)] : [],
      stage ? "High" : "Low",
    );
    fields["deal-risk-summary"] = field(
      openRisks.length || overdue
        ? `${openRisks.length} open risk${openRisks.length === 1 ? "" : "s"} and ${overdue} overdue follow-up${overdue === 1 ? "" : "s"} require attention.`
        : recent
          ? `No open structured risks or overdue follow-ups are recorded. The latest engagement was ${recent.label} on ${recent.occurredAt.slice(0, 10)}.`
          : "No open structured risks are recorded, but engagement history is insufficient to confirm low risk.",
      "Based on open deal risks, overdue tasks, and recent customer engagement.",
      [...openRisks.slice(0, 3).map(cite), ...(recent ? [cite(recent)] : [])],
      openRisks.length || overdue || recent ? "High" : "Low",
    );
    fields["recommended-next-action"] = field(
      recommendation ||
        "Review the deal record and confirm the next customer action.",
      recommendation
        ? "Uses the current governed recommendation or recorded deal next step."
        : "No specific next step or governed recommendation is recorded.",
      sourceCitations,
      recommendation ? "High" : "Low",
    );
    const evidenceTypes = ["activity", "note", "stakeholder", "meeting"],
      matches = (pattern: RegExp) => matching(sources, pattern, evidenceTypes);
    meddpiccResults.metrics = meddpicc(
      matches(
        /\b(metric|kpi|roi|return on investment|cost|revenue|savings|throughput|capacity|percent|%|\$)\b/i,
      ),
      "measurable business outcomes",
    );
    const economic = matches(
      /economic buyer|budget owner|final budget|cfo|finance approval/i,
    );
    meddpiccResults["economic-buyer"] = meddpicc(
      economic,
      "an identified economic buyer",
      economic.some(
        (source) =>
          source.sourceType === "stakeholder" &&
          /economic buyer/i.test(source.content),
      ),
    );
    meddpiccResults["decision-criteria"] = meddpicc(
      matches(
        /decision criteria|selection criteria|requirement|must have|evaluation criteria|technical criteria|security requirement/i,
      ),
      "documented decision criteria",
    );
    meddpiccResults["decision-process"] = meddpicc(
      matches(
        /decision process|approval process|committee|decision date|evaluation step|sign[- ]?off|approver/i,
      ),
      "the customer's decision process",
    );
    meddpiccResults["paper-process"] = meddpicc(
      matches(
        /paper process|procurement|legal|contract|nda|purchase order|terms|vendor onboarding/i,
      ),
      "the paper and procurement process",
    );
    meddpiccResults["identify-pain"] = meddpicc(
      matches(
        /pain|problem|challenge|risk|need|blocked|delay|cost of inaction|business impact/i,
      ),
      "a quantified or explicit customer pain",
    );
    const champion = matches(/\bchampion\b|internal advocate|advocate for/i);
    meddpiccResults.champion = meddpicc(
      champion,
      "an active champion",
      champion.some(
        (source) =>
          source.sourceType === "stakeholder" &&
          /champion/i.test(source.content),
      ),
    );
    meddpiccResults.competition = meddpicc(
      matches(
        /competitor|competition|alternative|incumbent|build internally|do nothing|status quo/i,
      ),
      "the competitive alternative or status quo",
    );
  }
  const allResults = [
      ...Object.values(fields),
      ...Object.values(meddpiccResults),
    ],
    supported = allResults.filter((item) =>
      "value" in item ? Boolean(item.value) : item.status !== "Unknown",
    ).length,
    total = allResults.length,
    dataGaps: string[] = [];
  if (
    !sources.some((source) =>
      ["activity", "note", "meeting"].includes(source.sourceType),
    )
  )
    dataGaps.push(
      "No customer activity, note, or meeting evidence is available.",
    );
  if (entityType === "deal")
    for (const definition of meddpiccDefinitions)
      if (meddpiccResults[definition.key]?.status === "Unknown")
        dataGaps.push(`${definition.label} is not evidenced.`);
  return {
    fields,
    meddpicc: meddpiccResults,
    confidence:
      supported === total && total
        ? "High"
        : supported >= Math.ceil(total / 2)
          ? "Medium"
          : "Low",
    explanation: `Rules-based ${entityType} fields generated from current ClientRecord records. No external enrichment was used.`,
    dataGaps,
  };
}

const citationSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    sourceType: { type: "string" },
    sourceId: { type: "string" },
    label: { type: "string" },
    excerpt: { type: "string" },
    occurredAt: { type: "string" },
  },
  required: ["sourceType", "sourceId", "label", "excerpt", "occurredAt"],
};
const fieldSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    value: { type: "string" },
    explanation: { type: "string" },
    confidence: { type: "string", enum: ["Low", "Medium", "High"] },
    citations: { type: "array", items: citationSchema },
  },
  required: ["value", "explanation", "confidence", "citations"],
};
const meddpiccSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    status: { type: "string", enum: ["Unknown", "Partial", "Confirmed"] },
    explanation: { type: "string" },
    citations: { type: "array", items: citationSchema },
  },
  required: ["status", "explanation", "citations"],
};
export function aiRecordResponseSchema(entityType: AIEntityType) {
  const fields = Object.fromEntries(
      aiFieldDefinitions[entityType].map((definition) => [
        definition.key,
        fieldSchema,
      ]),
    ),
    meddpiccProperties = Object.fromEntries(
      meddpiccDefinitions.map((definition) => [definition.key, meddpiccSchema]),
    );
  return {
    type: "object",
    additionalProperties: false,
    properties: {
      fields: {
        type: "object",
        additionalProperties: false,
        properties: fields,
        required: Object.keys(fields),
      },
      meddpicc: {
        type: "object",
        additionalProperties: false,
        properties: entityType === "deal" ? meddpiccProperties : {},
        required: entityType === "deal" ? Object.keys(meddpiccProperties) : [],
      },
      confidence: { type: "string", enum: ["Low", "Medium", "High"] },
      explanation: { type: "string" },
      dataGaps: { type: "array", items: { type: "string" } },
    },
    required: ["fields", "meddpicc", "confidence", "explanation", "dataGaps"],
  } as const;
}
