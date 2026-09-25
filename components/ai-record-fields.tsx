"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Check,
  ChevronDown,
  ChevronUp,
  Lock,
  LockOpen,
  Pencil,
  RotateCcw,
  ShieldCheck,
  Sparkles,
  X,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";

type EntityType = "company" | "contact" | "deal";
type Citation = {
  sourceType: string;
  sourceId: string;
  label: string;
  excerpt: string;
  occurredAt: string;
};
type GeneratedField = {
  value: string;
  explanation: string;
  confidence: string;
  citations: Citation[];
};
type GeneratedMeddpicc = {
  status: string;
  explanation: string;
  citations: Citation[];
};
type Artifact = {
  id: string;
  reviewStatus: string;
  content: {
    fields: Record<string, GeneratedField>;
    meddpicc: Record<string, GeneratedMeddpicc>;
    confidence: string;
    explanation: string;
    dataGaps: string[];
  };
  provider: string;
  model: string;
  promptVersion: number;
  rulesVersion: string;
  generatedBy: string;
  generatedAt: string;
  reviewedBy: string | null;
  reviewedAt: string | null;
  sourceCount: number;
};
type StoredField = {
  id: string;
  fieldKey: string;
  value: string;
  explanation: string;
  confidence: string;
  citations: Citation[];
  sourceArtifactId: string | null;
  manualOverride: boolean;
  locked: boolean;
  updatedBy: string;
  updatedAt: string;
};
type Definition = { key: string; label: string; kind?: string };
type State = {
  definitions: Definition[];
  meddpiccDefinitions: Definition[];
  fields: StoredField[];
  artifact: Artifact | null;
  providerConfigured: boolean;
  settings: { enabled: boolean };
  permissions: { generate: boolean; review: boolean; edit: boolean };
};
type Props = { entityType: EntityType; entityId: number; compact?: boolean };
const when = (value: unknown) =>
  value ? new Date(String(value)).toLocaleString() : "";
const confidenceTone = (value: string) =>
  value === "High"
    ? "text-emerald-700"
    : value === "Medium"
      ? "text-amber-700"
      : "text-slate-500";

export function AIRecordFieldsPanel({
  entityType,
  entityId,
  compact = false,
}: Props) {
  const [data, setData] = useState<State | null>(null),
    [busy, setBusy] = useState(""),
    [error, setError] = useState(""),
    [notice, setNotice] = useState(""),
    [expanded, setExpanded] = useState(!compact),
    [editing, setEditing] = useState<string | null>(null);
  const load = useCallback(async () => {
    const response = await fetch(
        `/api/ai-record-fields?entityType=${entityType}&entityId=${entityId}`,
        { cache: "no-store" },
      ),
      body = (await response.json()) as State & { error?: string };
    if (!response.ok) throw new Error(body.error);
    setData(body);
  }, [entityType, entityId]);
  useEffect(() => {
    let cancelled = false;
    const timer = window.setTimeout(() => {
      void load().catch((reason) => {
        if (!cancelled)
          setError(
            reason instanceof Error
              ? reason.message
              : "AI record fields could not load.",
          );
      });
    }, 0);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [load]);
  const request = async (payload: Record<string, unknown>, message: string) => {
    setBusy(String(payload.action));
    setError("");
    try {
      const response = await fetch("/api/ai-record-fields", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ entityType, entityId, ...payload }),
        }),
        body = (await response.json()) as {
          error?: string;
          skipped?: string[];
        };
      if (!response.ok) throw new Error(body.error);
      await load();
      setNotice(
        body.skipped?.length
          ? `${message}; ${body.skipped.length} locked field${body.skipped.length === 1 ? " was" : "s were"} preserved.`
          : message,
      );
      window.setTimeout(() => setNotice(""), 3200);
      return true;
    } catch (reason) {
      setError(
        reason instanceof Error
          ? reason.message
          : "The AI record-field action failed.",
      );
      return false;
    } finally {
      setBusy("");
    }
  };
  const generate = (force = false) =>
    request(
      { action: "generate", force },
      force ? "Fresh record fields generated" : "Record fields generated",
    );
  const review = (status: "Accepted" | "Rejected") =>
    data?.artifact &&
    request(
      { action: "review", artifactId: data.artifact.id, status },
      status === "Accepted" ? "Fields accepted and applied" : "Result rejected",
    );
  const stored = useMemo(
    () =>
      Object.fromEntries(
        (data?.fields || []).map((item) => [item.fieldKey, item]),
      ),
    [data],
  );
  if (!expanded)
    return (
      <section className="rounded-xl border bg-white">
        <button
          className="flex w-full items-center gap-3 p-4 text-left"
          onClick={() => setExpanded(true)}
        >
          <Sparkles size={17} className="text-blue-600" />
          <span className="flex-1">
            <strong className="block text-sm">AI record fields</strong>
            <span className="text-xs text-slate-500">
              Summaries, classifications, evidence, and locked manual values
            </span>
          </span>
          <Badge variant="secondary">{data?.fields.length || 0} saved</Badge>
          <ChevronDown size={16} />
        </button>
      </section>
    );
  return (
    <section className="rounded-2xl border bg-white p-5 shadow-sm">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <div className="flex items-center gap-2">
            <Sparkles size={19} className="text-blue-600" />
            <h3 className="text-lg font-semibold">AI record fields</h3>
            {compact && (
              <button
                aria-label="Collapse AI record fields"
                onClick={() => setExpanded(false)}
              >
                <ChevronUp size={16} />
              </button>
            )}
          </div>
          <p className="mt-2 max-w-3xl text-sm leading-6 text-slate-600">
            Classifications cite their CRM sources and remain reviewable. Lock an approved
            manual value to prevent later generations from replacing it.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Badge
            variant={
              data?.settings.enabled && data.providerConfigured
                ? "default"
                : "secondary"
            }
          >
            {data?.settings.enabled && data.providerConfigured
              ? "Model-backed"
              : "Rules-based"}
          </Badge>
          <Button
            size="sm"
            onClick={() => void generate(false)}
            disabled={!data?.permissions.generate || Boolean(busy)}
          >
            <Sparkles size={14} />
            {busy === "generate" ? "Generating…" : "Generate"}
          </Button>
        </div>
      </div>
      {error && (
        <p
          role="alert"
          className="mt-4 rounded-xl bg-red-50 p-3 text-sm text-red-700"
        >
          {error}
        </p>
      )}
      {notice && (
        <p
          role="status"
          className="mt-4 flex items-center gap-2 rounded-xl bg-emerald-50 p-3 text-sm text-emerald-800"
        >
          <Check size={15} />
          {notice}
        </p>
      )}
      {data?.artifact && (
        <ArtifactReview
          artifact={data.artifact}
          definitions={data.definitions}
          meddpiccDefinitions={data.meddpiccDefinitions}
          busy={Boolean(busy)}
          review={review}
          regenerate={() => generate(true)}
          canReview={data.permissions.review}
        />
      )}
      <div className="mt-5 grid gap-4 lg:grid-cols-2">
        {data?.definitions.map((definition) => (
          <SavedField
            key={definition.key}
            definition={definition}
            item={stored[definition.key]}
            canEdit={data.permissions.edit && data.permissions.review}
            editing={editing === definition.key}
            setEditing={setEditing}
            request={request}
          />
        ))}
      </div>
      {!!data?.meddpiccDefinitions.length && (
        <div className="mt-6">
          <div className="flex items-center gap-2">
            <ShieldCheck size={17} className="text-blue-600" />
            <h4 className="font-semibold">MEDDPICC completeness</h4>
          </div>
          <p className="mt-1 text-xs text-slate-500">
            Partial and Confirmed elements require a supporting activity, note,
            stakeholder, or meeting citation.
          </p>
          <div className="mt-4 grid gap-3 md:grid-cols-2">
            {data.meddpiccDefinitions.map((definition) => (
              <SavedField
                key={definition.key}
                definition={{
                  ...definition,
                  key: `meddpicc.${definition.key}`,
                }}
                item={stored[`meddpicc.${definition.key}`]}
                canEdit={data.permissions.edit && data.permissions.review}
                editing={editing === `meddpicc.${definition.key}`}
                setEditing={setEditing}
                request={request}
                meddpicc
              />
            ))}
          </div>
        </div>
      )}
      {!data?.fields.length && !data?.artifact && (
        <p className="mt-5 rounded-xl border border-dashed p-5 text-center text-sm text-slate-500">
          Generate the first governed result for this record. Nothing is applied
          until a reviewer accepts it.
        </p>
      )}
    </section>
  );
}

function ArtifactReview({
  artifact,
  definitions,
  meddpiccDefinitions,
  busy,
  review,
  regenerate,
  canReview,
}: {
  artifact: Artifact;
  definitions: Definition[];
  meddpiccDefinitions: Definition[];
  busy: boolean;
  review: (status: "Accepted" | "Rejected") => void;
  regenerate: () => void;
  canReview: boolean;
}) {
  return (
    <div className="mt-5 rounded-xl border border-blue-200 bg-blue-50/40 p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <div className="flex flex-wrap items-center gap-2">
            <strong>Latest generated result</strong>
            <Badge
              variant={
                artifact.reviewStatus === "Rejected"
                  ? "destructive"
                  : "secondary"
              }
            >
              {artifact.reviewStatus}
            </Badge>
            <Badge variant="outline">
              {artifact.content.confidence} confidence
            </Badge>
          </div>
          <p className="mt-1 text-xs text-slate-500">
            {when(artifact.generatedAt)} · {artifact.sourceCount} sources ·{" "}
            {artifact.model} · prompt v{artifact.promptVersion} · rules{" "}
            {artifact.rulesVersion}
          </p>
        </div>
        <Button
          size="sm"
          variant="outline"
          disabled={busy}
          onClick={regenerate}
        >
          <RotateCcw size={14} />
          Regenerate
        </Button>
      </div>
      <div className="mt-4 grid gap-3 md:grid-cols-2">
        {definitions.map((definition) => {
          const field = artifact.content.fields[definition.key];
          return (
            <Preview
              key={definition.key}
              label={definition.label}
              value={field?.value || "Not generated"}
              explanation={field?.explanation || ""}
              citations={field?.citations || []}
            />
          );
        })}
        {meddpiccDefinitions.map((definition) => {
          const item = artifact.content.meddpicc[definition.key];
          return (
            <Preview
              key={definition.key}
              label={`MEDDPICC · ${definition.label}`}
              value={item?.status || "Unknown"}
              explanation={item?.explanation || ""}
              citations={item?.citations || []}
            />
          );
        })}
      </div>
      <div className="mt-4 rounded-lg bg-white p-3 text-sm text-slate-600">
        <strong className="text-slate-900">Why this result</strong>
        <p className="mt-1 leading-6">{artifact.content.explanation}</p>
        {artifact.content.dataGaps.length > 0 && (
          <p className="mt-2 text-amber-700">
            Data gaps: {artifact.content.dataGaps.join(" ")}
          </p>
        )}
      </div>
      {artifact.reviewStatus === "Draft" && (
        <div className="mt-4 flex flex-wrap gap-2">
          <Button
            size="sm"
            disabled={!canReview || busy}
            onClick={() => review("Accepted")}
          >
            <Check size={14} />
            Accept and apply
          </Button>
          <Button
            size="sm"
            variant="outline"
            disabled={!canReview || busy}
            onClick={() => review("Rejected")}
          >
            <X size={14} />
            Reject
          </Button>
          <span className="self-center text-xs text-slate-500">
            Locked fields will be preserved.
          </span>
        </div>
      )}
    </div>
  );
}

function Preview({
  label,
  value,
  explanation,
  citations,
}: {
  label: string;
  value: string;
  explanation: string;
  citations: Citation[];
}) {
  return (
    <div className="rounded-lg border bg-white p-3">
      <p className="text-xs font-medium text-slate-500">{label}</p>
      <p className="mt-1 text-sm font-semibold">{value}</p>
      {explanation && (
        <p className="mt-1 text-xs leading-5 text-slate-600">{explanation}</p>
      )}
      <Citations items={citations} />
    </div>
  );
}

function SavedField({
  definition,
  item,
  canEdit,
  editing,
  setEditing,
  request,
  meddpicc = false,
}: {
  definition: Definition;
  item?: StoredField;
  canEdit: boolean;
  editing: boolean;
  setEditing: (key: string | null) => void;
  request: (
    payload: Record<string, unknown>,
    message: string,
  ) => Promise<boolean>;
  meddpicc?: boolean;
}) {
  const [value, setValue] = useState(""),
    [explanation, setExplanation] = useState(""),
    [locked, setLocked] = useState(false);
  const start = () => {
    setValue(String(item?.value || ""));
    setExplanation(item?.explanation || "");
    setLocked(Boolean(item?.locked));
    setEditing(definition.key);
  };
  const save = async () => {
    if (
      await request(
        {
          action: "saveField",
          fieldKey: definition.key,
          value,
          explanation,
          locked,
        },
        `${definition.label} saved`,
      )
    )
      setEditing(null);
  };
  return (
    <div
      className={`rounded-xl border p-4 ${item?.locked ? "border-amber-200 bg-amber-50/30" : "bg-white"}`}
    >
      {editing ? (
        <div className="grid gap-3">
          <label className="grid gap-1 text-xs font-medium">
            {definition.label}
            {meddpicc ? (
              <select
                className="h-10 rounded-md border bg-white px-3 text-sm"
                value={value || "Unknown"}
                onChange={(event) => setValue(event.target.value)}
              >
                <option>Unknown</option>
                <option>Partial</option>
                <option>Confirmed</option>
              </select>
            ) : definition.kind === "text" ? (
              <Textarea
                rows={4}
                value={value}
                onChange={(event) => setValue(event.target.value)}
              />
            ) : (
              <Input
                value={value}
                onChange={(event) => setValue(event.target.value)}
              />
            )}
          </label>
          <label className="grid gap-1 text-xs font-medium">
            Explanation
            <Textarea
              rows={3}
              value={explanation}
              onChange={(event) => setExplanation(event.target.value)}
            />
          </label>
          <label className="flex items-center gap-2 text-xs">
            <input
              type="checkbox"
              checked={locked}
              onChange={(event) => setLocked(event.target.checked)}
            />
            Lock this manual value against later AI runs
          </label>
          <div className="flex gap-2">
            <Button size="sm" onClick={() => void save()}>
              <Check size={14} />
              Save
            </Button>
            <Button
              size="sm"
              variant="outline"
              onClick={() => setEditing(null)}
            >
              Cancel
            </Button>
          </div>
        </div>
      ) : (
        <>
          <div className="flex items-start justify-between gap-3">
            <div>
              <p className="text-xs font-medium text-slate-500">
                {definition.label}
              </p>
              <p className="mt-1 whitespace-pre-wrap text-sm font-semibold">
                {item?.value || "Not set"}
              </p>
            </div>
            <div className="flex items-center gap-1">
              {item?.manualOverride && (
                <Badge variant="secondary">Manual</Badge>
              )}
              {item?.locked ? (
                <Lock size={15} className="text-amber-600" />
              ) : (
                <LockOpen size={15} className="text-slate-300" />
              )}
              {canEdit && (
                <button aria-label={`Edit ${definition.label}`} onClick={start}>
                  <Pencil size={15} className="text-slate-500" />
                </button>
              )}
            </div>
          </div>
          {item?.explanation && (
            <p className="mt-2 text-xs leading-5 text-slate-600">
              {item.explanation}
            </p>
          )}
          {item && (
            <div className="mt-2 flex flex-wrap gap-2 text-[11px] text-slate-500">
              <span className={confidenceTone(item.confidence)}>
                {item.confidence} confidence
              </span>
              <span>Updated {when(item.updatedAt)}</span>
              <span>by {item.updatedBy}</span>
            </div>
          )}
          <Citations items={item?.citations || []} />
        </>
      )}
    </div>
  );
}

function Citations({ items }: { items: Citation[] }) {
  if (!items.length) return null;
  return (
    <details className="mt-3">
      <summary className="cursor-pointer text-xs font-medium text-blue-700">
        {items.length} supporting source{items.length === 1 ? "" : "s"}
      </summary>
      <div className="mt-2 grid gap-2">
        {items.map((item, index) => (
          <div
            key={`${item.sourceType}-${item.sourceId}-${index}`}
            className="rounded-md bg-slate-50 p-2 text-xs"
          >
            <strong>
              {item.label || `${item.sourceType} ${item.sourceId}`}
            </strong>
            <p className="mt-1 line-clamp-3 text-slate-600">{item.excerpt}</p>
            <span className="mt-1 block text-[10px] uppercase tracking-wide text-slate-400">
              {item.sourceType} · {when(item.occurredAt)}
            </span>
          </div>
        ))}
      </div>
    </details>
  );
}
