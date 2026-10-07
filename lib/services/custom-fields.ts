import { ServiceError } from "@/lib/services/errors";

type Row = Record<string, unknown>;
export type CustomFieldEntity = "contact" | "company" | "deal";
export type ResolvedCustomField = { id: number; name: string; value: string };
type Definition = { id: number; name: string; fieldKey: string; fieldType: string; options: string[] };

const options = (v: unknown) => { try { const parsed = JSON.parse(String(v || "[]")); return Array.isArray(parsed) ? parsed.map(String) : []; } catch { return []; } };
// Same checks and messages as the CRM routes (app/api/crm customFieldChanges, app/api/advanced customFieldError).
const invalid = (d: Definition, value: string) => value.length > 4000 ? "Custom field values are limited to 4,000 characters." : !value ? "" : d.fieldType === "number" && !Number.isFinite(Number(value)) ? "Enter a valid number in each number field." : d.fieldType === "date" && !/^\d{4}-\d{2}-\d{2}$/.test(value) ? "Enter a valid date in each date field." : d.fieldType === "boolean" && !["true", "false"].includes(value) ? "Choose Yes or No for each yes/no field." : d.fieldType === "select" && !d.options.includes(value) ? `${d.name} must be one of: ${d.options.join(", ")}.` : "";

async function definitions(db: D1Database, entityType: CustomFieldEntity): Promise<Definition[]> {
  return (await db.prepare("SELECT id,name,field_key AS fieldKey,field_type AS fieldType,options FROM custom_field_definitions WHERE entity_type=? ORDER BY name").bind(entityType).all<Row>()).results.map(d => ({ id: Number(d.id), name: String(d.name), fieldKey: String(d.fieldKey), fieldType: String(d.fieldType), options: options(d.options) }));
}

/** Validates a `{ "Field name" or field_key: value }` object (case-insensitive keys; null or "" clears; select options match case-insensitively and are stored as configured). */
export async function resolveCustomFields(db: D1Database, entityType: CustomFieldEntity, fields: unknown): Promise<ResolvedCustomField[]> {
  if (fields === undefined) return [];
  if (!fields || typeof fields !== "object" || Array.isArray(fields)) throw new ServiceError("fields must be an object keyed by field name.");
  const defs = await definitions(db, entityType), resolved = new Map<number, ResolvedCustomField>();
  for (const [key, raw] of Object.entries(fields as Row)) {
    const wanted = key.trim().toLowerCase(), d = defs.find(f => f.name.toLowerCase() === wanted || f.fieldKey.toLowerCase() === wanted);
    if (!d) throw new ServiceError(defs.length ? `Unknown ${entityType} field "${key.slice(0, 80)}". Fields: ${defs.map(f => f.name).join(", ")}.` : `There are no ${entityType} custom fields.`);
    if (raw !== null && !["string", "number", "boolean"].includes(typeof raw)) throw new ServiceError(`${d.name} must be text, a number, true/false or null.`);
    let value = raw === null ? "" : String(raw).trim();
    if (d.fieldType === "select") value = d.options.find(o => o.toLowerCase() === value.toLowerCase()) ?? value;
    const error = invalid(d, value); if (error) throw new ServiceError(error);
    resolved.set(d.id, { id: d.id, name: d.name, value });
  }
  return [...resolved.values()];
}

export function customFieldStatements(db: D1Database, entityType: CustomFieldEntity, entityId: number, values: ResolvedCustomField[], now: string) {
  return values.flatMap(f => [db.prepare("DELETE FROM custom_field_values WHERE definition_id=? AND entity_type=? AND entity_id=?").bind(f.id, entityType, entityId), ...(f.value ? [db.prepare("INSERT INTO custom_field_values(definition_id,entity_type,entity_id,value,updated_at) VALUES (?,?,?,?,?)").bind(f.id, entityType, entityId, f.value, now)] : [])]);
}

/** Each record's set custom field values keyed by field name (every requested id is present, possibly with {}). */
export async function customFieldsByRecord(db: D1Database, entityType: CustomFieldEntity, ids: number[]): Promise<Map<number, Record<string, string>>> {
  const out = new Map(ids.map(id => [id, {} as Record<string, string>]));
  if (!ids.length) return out;
  const rows = (await db.prepare(`SELECT v.entity_id AS entityId,f.name,v.value FROM custom_field_values v JOIN custom_field_definitions f ON f.id=v.definition_id AND f.entity_type=v.entity_type WHERE v.entity_type=? AND v.entity_id IN (${ids.map(() => "?").join(",")}) ORDER BY f.name`).bind(entityType, ...ids).all<Row>()).results;
  for (const r of rows) out.get(Number(r.entityId))![String(r.name)] = String(r.value);
  return out;
}
