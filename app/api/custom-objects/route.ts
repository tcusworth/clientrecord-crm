import { env } from "cloudflare:workers";
import { audit, can, canAdmin, crmUser, type CRMUser } from "@/lib/crm-auth";

type Row = Record<string, unknown>;
type Values = Record<string, string | number | boolean | null>;

const text = (value: unknown, max = 200) => String(value ?? "").trim().slice(0, max);
const slug = (value: unknown) => text(value, 80).toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
const parseJson = <T,>(value: unknown, fallback: T): T => { try { return JSON.parse(String(value ?? "")) as T; } catch { return fallback; } };
const rows = async (sql: string, ...values: unknown[]) => (await env.DB.prepare(sql).bind(...values).all<Row>()).results;
const one = async (sql: string, ...values: unknown[]) => env.DB.prepare(sql).bind(...values).first<Row>();
const denied = (user: CRMUser | null, permission: "records.view" | "records.edit") => !user
  ? Response.json({ error:"Sign in is required." }, { status:401 })
  : !can(user, permission) ? Response.json({ error:`${permission === "records.view" ? "View" : "Edit"} access is required.` }, { status:403 }) : null;

const standardTypes = new Set(["company", "contact", "deal", "document"]);
const fieldTypes = new Set(["text", "long_text", "number", "currency", "date", "boolean", "select", "email", "url"]);
const endpointType = (value: unknown) => {
  const type = text(value, 120);
  if (standardTypes.has(type) || /^custom:[0-9a-f-]{36}$/i.test(type)) return type;
  throw new Error("Choose a valid record type.");
};

async function customTypeId(type: string) {
  if (!type.startsWith("custom:")) return null;
  const id = type.slice(7);
  return await one("SELECT id FROM custom_object_types WHERE id=? AND status='Active'", id) ? id : null;
}

async function recordExists(type: string, id: string, allowSensitive: boolean) {
  if (type.startsWith("custom:")) return Boolean(await one("SELECT id FROM custom_object_records WHERE id=? AND object_type_id=? AND status='Active'", id, type.slice(7)));
  const table = type === "company" ? "companies" : type === "contact" ? "contacts" : type === "deal" ? "deals" : "client_documents";
  const extra = type === "document" && !allowSensitive ? " AND sensitive=0" : "";
  return Boolean(await one(`SELECT id FROM ${table} WHERE id=?${extra}`, id));
}

function normalizedValue(field: Row, raw: unknown) {
  const kind = String(field.fieldType), value = typeof raw === "string" ? raw.trim().slice(0, 10000) : raw;
  if (kind === "boolean") return value === true || value === "true" || value === "on";
  if (kind === "number" || kind === "currency") {
    if (value === "" || value == null) return null;
    const number = Number(value); if (!Number.isFinite(number)) throw new Error(`${field.label} must be a number.`); return number;
  }
  if (kind === "select" && value) {
    const options = parseJson<string[]>(field.optionsJson, []);
    if (!options.includes(String(value))) throw new Error(`Choose a valid ${field.label}.`);
  }
  return value == null ? "" : String(value);
}

async function readAll(user: CRMUser) {
  const allowSensitive = can(user, "documents.manage_sensitive");
  const [objectTypes, fields, records, layouts, relationshipTypes, relationships, rollups, companies, contacts, deals, documents] = await Promise.all([
    rows("SELECT id,key,singular_name AS singularName,plural_name AS pluralName,description,icon,title_field_key AS titleFieldKey,status,created_by AS createdBy,created_at AS createdAt,updated_at AS updatedAt FROM custom_object_types WHERE status='Active' ORDER BY plural_name"),
    rows("SELECT id,object_type_id AS objectTypeId,key,label,field_type AS fieldType,options_json AS optionsJson,required,sort_order AS sortOrder,show_in_list AS showInList FROM custom_object_fields ORDER BY object_type_id,sort_order,label"),
    rows("SELECT id,object_type_id AS objectTypeId,display_name AS displayName,values_json AS valuesJson,owner,status,created_by AS createdBy,created_at AS createdAt,updated_at AS updatedAt FROM custom_object_records WHERE status='Active' ORDER BY updated_at DESC LIMIT 1500"),
    rows("SELECT id,object_type_id AS objectTypeId,name,sections_json AS sectionsJson,is_default AS isDefault FROM custom_object_layouts ORDER BY object_type_id,is_default DESC,name"),
    rows("SELECT id,name,from_type AS fromType,to_type AS toType,from_label AS fromLabel,to_label AS toLabel,cardinality FROM custom_relationship_types ORDER BY name"),
    rows("SELECT id,relationship_type_id AS relationshipTypeId,from_entity_type AS fromEntityType,from_entity_id AS fromEntityId,to_entity_type AS toEntityType,to_entity_id AS toEntityId,note,created_by AS createdBy,created_at AS createdAt FROM custom_relationships ORDER BY created_at DESC LIMIT 3000"),
    rows("SELECT id,object_type_id AS objectTypeId,key,label,relationship_type_id AS relationshipTypeId,aggregate,source_field_key AS sourceFieldKey FROM custom_rollup_definitions ORDER BY object_type_id,label"),
    rows("SELECT CAST(id AS TEXT) AS id,name AS label FROM companies ORDER BY name LIMIT 700"),
    rows("SELECT CAST(id AS TEXT) AS id,trim(first_name||' '||last_name) AS label FROM contacts ORDER BY first_name,last_name LIMIT 1000"),
    rows("SELECT CAST(id AS TEXT) AS id,name AS label,value FROM deals ORDER BY updated_at DESC LIMIT 700"),
    rows(`SELECT id,title AS label FROM client_documents WHERE status='Active'${allowSensitive ? "" : " AND sensitive=0"} ORDER BY updated_at DESC LIMIT 700`),
  ]);
  const parsedRecords: Array<Row & { values: Values }> = records.map(record => ({ ...record, values:parseJson<Values>(record.valuesJson, {}) }));
  const recordById = new Map(parsedRecords.map(record => [String(record.id), record]));
  const relationshipById = new Map(relationshipTypes.map(type => [String(type.id), type]));
  const rollupValues: Record<string, Record<string, number | null>> = {};
  for (const definition of rollups) {
    const objectType = `custom:${definition.objectTypeId}`, relationship = relationshipById.get(String(definition.relationshipTypeId));
    if (!relationship || (relationship.fromType !== objectType && relationship.toType !== objectType)) continue;
    for (const record of parsedRecords.filter(item => item.objectTypeId === definition.objectTypeId)) {
      const links = relationships.filter(link => link.relationshipTypeId === definition.relationshipTypeId && ((relationship.fromType === objectType && link.fromEntityId === record.id) || (relationship.toType === objectType && link.toEntityId === record.id)));
      const values = links.map(link => {
        const relatedType = relationship.fromType === objectType ? String(link.toEntityType) : String(link.fromEntityType);
        const relatedId = relationship.fromType === objectType ? String(link.toEntityId) : String(link.fromEntityId);
        if (definition.aggregate === "count") return 1;
        if (relatedType === "deal" && definition.sourceFieldKey === "value") return Number(deals.find(item => item.id === relatedId)?.value);
        const related = recordById.get(relatedId); return Number((related?.values as Values | undefined)?.[String(definition.sourceFieldKey)]);
      }).filter(value => Number.isFinite(value));
      const key = String(record.id); rollupValues[key] ||= {};
      rollupValues[key][String(definition.key)] = definition.aggregate === "count" ? links.length : values.length === 0 ? null : definition.aggregate === "sum" ? values.reduce((sum, value) => sum + value, 0) : definition.aggregate === "average" ? values.reduce((sum, value) => sum + value, 0) / values.length : definition.aggregate === "min" ? Math.min(...values) : Math.max(...values);
    }
  }
  return { objectTypes, fields:fields.map(field => ({ ...field, options:parseJson<string[]>(field.optionsJson, []) })), records:parsedRecords, layouts:layouts.map(layout => ({ ...layout, sections:parseJson(layout.sectionsJson, []) })), relationshipTypes, relationships, rollups, rollupValues, standardRecords:{ company:companies, contact:contacts, deal:deals, document:documents }, account:{ email:user.email, role:user.role }, permissions:{ edit:can(user,"records.edit"), admin:canAdmin(user.role) } };
}

export async function GET(request: Request) {
  const user = await crmUser(request), error = denied(user, "records.view"); if (error || !user) return error;
  try { return Response.json(await readAll(user)); } catch (cause) { return Response.json({ error:cause instanceof Error ? cause.message : "The data model is unavailable." }, { status:400 }); }
}

export async function POST(request: Request) {
  const user = await crmUser(request), error = denied(user, "records.edit"); if (error || !user) return error;
  try {
    const body = await request.json() as Row, action = text(body.action, 50), now = new Date().toISOString();
    if (["saveObjectType", "saveField", "saveLayout", "saveRelationshipType", "saveRollup"].includes(action) && !canAdmin(user.role)) return Response.json({ error:"Administrator access is required." }, { status:403 });
    if (action === "saveObjectType") {
      const id = text(body.id, 80) || crypto.randomUUID(), singularName = text(body.singularName, 80), pluralName = text(body.pluralName, 80), key = slug(body.key || pluralName);
      if (!singularName || !pluralName || !key) throw new Error("Enter singular and plural names.");
      const exists = await one("SELECT id FROM custom_object_types WHERE id=?", id);
      if (exists) await env.DB.prepare("UPDATE custom_object_types SET singular_name=?,plural_name=?,description=?,icon=?,updated_at=? WHERE id=?").bind(singularName,pluralName,text(body.description,500),text(body.icon,40)||"boxes",now,id).run();
      else await env.DB.batch([
        env.DB.prepare("INSERT INTO custom_object_types(id,key,singular_name,plural_name,description,icon,title_field_key,status,created_by,created_at,updated_at) VALUES(?,?,?,?,?,?,?,'Active',?,?,?)").bind(id,key,singularName,pluralName,text(body.description,500),text(body.icon,40)||"boxes","name",user.email,now,now),
        env.DB.prepare("INSERT INTO custom_object_fields(id,object_type_id,key,label,field_type,options_json,required,sort_order,show_in_list,created_at,updated_at) VALUES(?,?,?,?,?,'[]',1,0,1,?,?)").bind(crypto.randomUUID(),id,"name",`${singularName} name`,"text",now,now),
        env.DB.prepare("INSERT INTO custom_object_layouts(id,object_type_id,name,sections_json,is_default,created_at,updated_at) VALUES(?,?, 'Default',?,1,?,?)").bind(crypto.randomUUID(),id,JSON.stringify([{ title:"Details", fieldKeys:["name"] }]),now,now),
      ]);
      await audit(user,"custom_object_type.save","custom_object_type",id,`${exists ? "Updated" : "Created"} ${singularName} object type`,{key,pluralName});
    } else if (action === "saveField") {
      const objectTypeId = text(body.objectTypeId,80), objectType = await one("SELECT id FROM custom_object_types WHERE id=? AND status='Active'",objectTypeId), label = text(body.label,80), key = slug(body.key || label), fieldType = text(body.fieldType,30);
      if (!objectType || !label || !key || !fieldTypes.has(fieldType)) throw new Error("Complete the field definition.");
      const options = text(body.options,1000).split(",").map(item=>item.trim()).filter(Boolean).slice(0,50);
      const max = await one("SELECT coalesce(max(sort_order),-1) AS value FROM custom_object_fields WHERE object_type_id=?",objectTypeId), id=crypto.randomUUID();
      await env.DB.prepare("INSERT INTO custom_object_fields(id,object_type_id,key,label,field_type,options_json,required,sort_order,show_in_list,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)").bind(id,objectTypeId,key,label,fieldType,JSON.stringify(options),body.required?1:0,Number(max?.value||0)+1,body.showInList?1:0,now,now).run();
      await audit(user,"custom_object_field.create","custom_object_field",id,`Added ${label} field`,{objectTypeId,key,fieldType});
    } else if (action === "saveLayout") {
      const objectTypeId=text(body.objectTypeId,80); if(!await one("SELECT id FROM custom_object_types WHERE id=?",objectTypeId))throw new Error("Object type not found.");
      const validKeys=new Set((await rows("SELECT key FROM custom_object_fields WHERE object_type_id=?",objectTypeId)).map(item=>String(item.key))), requested=Array.isArray(body.sections)?body.sections:[];
      const sections=requested.slice(0,12).map(item=>{const section=item as Row;return {title:text(section.title,80)||"Details",fieldKeys:(Array.isArray(section.fieldKeys)?section.fieldKeys:[]).map(value=>text(value,80)).filter(value=>validKeys.has(value))};}).filter(section=>section.fieldKeys.length);
      if(!sections.length)throw new Error("Add at least one layout section with fields.");
      const existing=await one("SELECT id FROM custom_object_layouts WHERE object_type_id=? AND is_default=1",objectTypeId), id=String(existing?.id||crypto.randomUUID());
      if(existing)await env.DB.prepare("UPDATE custom_object_layouts SET sections_json=?,updated_at=? WHERE id=?").bind(JSON.stringify(sections),now,id).run();else await env.DB.prepare("INSERT INTO custom_object_layouts(id,object_type_id,name,sections_json,is_default,created_at,updated_at) VALUES(?,?,'Default',?,1,?,?)").bind(id,objectTypeId,JSON.stringify(sections),now,now).run();
      await audit(user,"custom_object_layout.save","custom_object_layout",id,"Updated record layout",{objectTypeId,sections});
    } else if (action === "saveRelationshipType") {
      const fromType=endpointType(body.fromType),toType=endpointType(body.toType);if(fromType.startsWith("custom:")&&!await customTypeId(fromType)||toType.startsWith("custom:")&&!await customTypeId(toType))throw new Error("A selected custom object type is unavailable.");
      const name=text(body.name,100),fromLabel=text(body.fromLabel,100),toLabel=text(body.toLabel,100),cardinality=text(body.cardinality,30);if(!name||!fromLabel||!toLabel||!["one_to_one","one_to_many","many_to_one","many_to_many"].includes(cardinality))throw new Error("Complete the relationship definition.");
      const id=crypto.randomUUID();await env.DB.prepare("INSERT INTO custom_relationship_types(id,name,from_type,to_type,from_label,to_label,cardinality,created_by,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?)").bind(id,name,fromType,toType,fromLabel,toLabel,cardinality,user.email,now,now).run();
      await audit(user,"custom_relationship_type.create","custom_relationship_type",id,`Created ${name} relationship`,{fromType,toType,cardinality});
    } else if (action === "saveRollup") {
      const objectTypeId=text(body.objectTypeId,80),relationshipTypeId=text(body.relationshipTypeId,80),relationship=await one("SELECT from_type AS fromType,to_type AS toType FROM custom_relationship_types WHERE id=?",relationshipTypeId),aggregate=text(body.aggregate,20),label=text(body.label,80),key=slug(body.key||label),sourceFieldKey=text(body.sourceFieldKey,80)||null;
      if(!relationship||!label||!key||!["count","sum","average","min","max"].includes(aggregate)||![relationship.fromType,relationship.toType].includes(`custom:${objectTypeId}`))throw new Error("Choose a relationship connected to this object type.");
      if(aggregate!=="count"&&!sourceFieldKey)throw new Error("Choose the related numeric field to summarize.");
      const id=crypto.randomUUID();await env.DB.prepare("INSERT INTO custom_rollup_definitions(id,object_type_id,key,label,relationship_type_id,aggregate,source_field_key,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?)").bind(id,objectTypeId,key,label,relationshipTypeId,aggregate,sourceFieldKey,now,now).run();
      await audit(user,"custom_rollup.create","custom_rollup",id,`Created ${label} rollup`,{objectTypeId,relationshipTypeId,aggregate,sourceFieldKey});
    } else if (action === "saveRecord") {
      const objectTypeId=text(body.objectTypeId,80),type=await one("SELECT singular_name AS singularName,title_field_key AS titleFieldKey FROM custom_object_types WHERE id=? AND status='Active'",objectTypeId);if(!type)throw new Error("Object type not found.");
      const fields=await rows("SELECT key,label,field_type AS fieldType,options_json AS optionsJson,required FROM custom_object_fields WHERE object_type_id=? ORDER BY sort_order",objectTypeId),input=body.values&&typeof body.values==="object"?body.values as Row:{},values:Values={};
      for(const field of fields){const value=normalizedValue(field,input[String(field.key)]);if(field.required&&(value===""||value==null))throw new Error(`${field.label} is required.`);values[String(field.key)]=value;}
      const displayName=text(values[String(type.titleFieldKey)]||values.name||Object.values(values).find(Boolean),180);if(!displayName)throw new Error(`Enter a ${type.singularName} name.`);
      const id=text(body.id,80)||crypto.randomUUID(),existing=await one("SELECT id FROM custom_object_records WHERE id=? AND object_type_id=?",id,objectTypeId);
      if(existing)await env.DB.prepare("UPDATE custom_object_records SET display_name=?,values_json=?,owner=?,status='Active',updated_at=? WHERE id=?").bind(displayName,JSON.stringify(values),text(body.owner,120),now,id).run();else await env.DB.prepare("INSERT INTO custom_object_records(id,object_type_id,display_name,values_json,owner,status,created_by,created_at,updated_at) VALUES(?,?,?,?,?,'Active',?,?,?)").bind(id,objectTypeId,displayName,JSON.stringify(values),text(body.owner,120)||user.email,user.email,now,now).run();
      await audit(user,"custom_object_record.save","custom_object_record",id,`${existing?"Updated":"Created"} ${displayName}`,{objectTypeId});
    } else if (action === "linkRecords") {
      const relationshipTypeId=text(body.relationshipTypeId,80),relationship=await one("SELECT from_type AS fromType,to_type AS toType,cardinality,name FROM custom_relationship_types WHERE id=?",relationshipTypeId);if(!relationship)throw new Error("Relationship type not found.");
      const fromEntityId=text(body.fromEntityId,100),toEntityId=text(body.toEntityId,100),fromType=String(relationship.fromType),toType=String(relationship.toType),allowSensitive=can(user,"documents.manage_sensitive");
      if(!await recordExists(fromType,fromEntityId,allowSensitive)||!await recordExists(toType,toEntityId,allowSensitive))throw new Error("One of the selected records is unavailable.");
      if(relationship.cardinality==="one_to_one"&&await one("SELECT id FROM custom_relationships WHERE relationship_type_id=? AND (from_entity_id=? OR to_entity_id=?)",relationshipTypeId,fromEntityId,toEntityId))throw new Error("That one-to-one relationship is already occupied.");
      if(relationship.cardinality==="one_to_many"&&await one("SELECT id FROM custom_relationships WHERE relationship_type_id=? AND to_entity_id=?",relationshipTypeId,toEntityId))throw new Error("The selected related record already belongs to another parent.");
      if(relationship.cardinality==="many_to_one"&&await one("SELECT id FROM custom_relationships WHERE relationship_type_id=? AND from_entity_id=?",relationshipTypeId,fromEntityId))throw new Error("The selected record already has a parent.");
      const id=crypto.randomUUID();await env.DB.prepare("INSERT INTO custom_relationships(id,relationship_type_id,from_entity_type,from_entity_id,to_entity_type,to_entity_id,note,created_by,created_at) VALUES(?,?,?,?,?,?,?,?,?)").bind(id,relationshipTypeId,fromType,fromEntityId,toType,toEntityId,text(body.note,500),user.email,now).run();
      await audit(user,"custom_relationship.create","custom_relationship",id,`Linked records with ${relationship.name}`,{relationshipTypeId,fromEntityId,toEntityId});
    } else if (action === "unlinkRecords") {
      if(!can(user,"records.delete"))return Response.json({error:"Delete permission is required."},{status:403});const id=text(body.id,80),existing=await one("SELECT * FROM custom_relationships WHERE id=?",id);if(!existing)throw new Error("Relationship not found.");await env.DB.prepare("DELETE FROM custom_relationships WHERE id=?").bind(id).run();await audit(user,"custom_relationship.delete","custom_relationship",id,"Removed linked-record relationship",existing);
    } else if (action === "archiveRecord") {
      if(!can(user,"records.delete"))return Response.json({error:"Delete permission is required."},{status:403});const id=text(body.id,80),record=await one("SELECT display_name AS displayName FROM custom_object_records WHERE id=?",id);if(!record)throw new Error("Record not found.");await env.DB.prepare("UPDATE custom_object_records SET status='Archived',updated_at=? WHERE id=?").bind(now,id).run();await audit(user,"custom_object_record.archive","custom_object_record",id,`Archived ${record.displayName}`);
    } else throw new Error("Unknown custom-object action.");
    return Response.json({ ok:true });
  } catch (cause) { return Response.json({ error:cause instanceof Error ? cause.message : "The data model could not be updated." }, { status:400 }); }
}
