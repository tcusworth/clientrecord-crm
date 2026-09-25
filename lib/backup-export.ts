import { env } from "cloudflare:workers";

// Tables left out of the full data export (/api/backup-export), with the reason. Every other table in sqlite_master is exported.
export const BACKUP_EXPORT_EXCLUDED_TABLES: Readonly<Record<string,string>> = Object.freeze({
  oauth_states:"Short-lived OAuth handshake state; worthless after the move.",
  rate_limits:"Transient rate-limit counters.",
  action_undo_log:"Short-lived undo buffer.",
  integration_accounts:"OAuth tokens are encrypted with a key that does not move; reconnect integrations after the import.",
  backup_snapshots:"Points at old R2 backup objects, which are not migrated.",
  webhook_endpoints:"Signing secrets are encrypted with a key that does not move; recreate webhooks after the import.",
  webhook_deliveries:"Delivery history of the webhook endpoints that are recreated.",
});
const INTERNAL_TABLE_PREFIXES=["sqlite_","_cf_","d1_","__drizzle"];
export type ExportTable={name:string;columns:string[]};
export type ManifestEntry={kind:"document_version"|"field_capture_audio"|"field_capture_attachment";key:string;filename:string;contentType:string;size:number|null;checksum:string|null;documentId?:string;version?:number;sensitive?:boolean;fieldCaptureId?:string};

export function isExportableTable(name:string){return !INTERNAL_TABLE_PREFIXES.some(prefix=>name.startsWith(prefix))&&!Object.hasOwn(BACKUP_EXPORT_EXCLUDED_TABLES,name);}
export function quoteIdentifier(name:string){return `"${name.replaceAll('"','""')}"`;}

// Discovered at runtime so tables added by later migrations are never missed. Only names read back from sqlite_master are ever interpolated.
export async function exportableTables():Promise<ExportTable[]>{
  const names=(await env.DB.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all<{name:string}>()).results.map(row=>String(row.name)).filter(isExportableTable);
  const tables:ExportTable[]=[];for(const name of names){const columns=(await env.DB.prepare(`PRAGMA table_info(${quoteIdentifier(name)})`).all<{name:string}>()).results.map(column=>String(column.name));tables.push({name,columns});}
  return tables;
}

const SHA256=/^[0-9a-f]{64}$/i;
// Every R2 object the data references: document versions and field-capture media. Operational backups (lib/operations.ts) are excluded.
export async function objectManifest():Promise<ManifestEntry[]>{
  const documents=(await env.DB.prepare("SELECT v.object_key AS objectKey,v.filename,v.content_type AS contentType,v.size,v.checksum,v.document_id AS documentId,v.version,COALESCE(d.sensitive,0) AS sensitive FROM document_versions v LEFT JOIN client_documents d ON d.id=v.document_id ORDER BY v.rowid").all<Record<string,unknown>>()).results;
  const entries:ManifestEntry[]=documents.map(row=>({kind:"document_version",key:String(row.objectKey),filename:String(row.filename),contentType:String(row.contentType||"application/octet-stream"),size:row.size==null?null:Number(row.size),checksum:SHA256.test(String(row.checksum||""))?String(row.checksum).toLowerCase():null,documentId:String(row.documentId),version:Number(row.version),sensitive:Boolean(row.sensitive)}));
  const captures=(await env.DB.prepare("SELECT id,audio_object_key AS audio,attachment_object_key AS attachment FROM field_captures WHERE audio_object_key IS NOT NULL OR attachment_object_key IS NOT NULL ORDER BY rowid").all<Record<string,unknown>>()).results;
  for(const capture of captures)for(const [kind,key,fallbackType] of [["field_capture_audio",capture.audio,"audio/webm"],["field_capture_attachment",capture.attachment,"image/jpeg"]] as const){
    if(!key)continue;const head=await env.BUCKET.head(String(key));
    entries.push({kind,key:String(key),filename:String(key).split("/").pop()||String(key),contentType:head?.httpMetadata?.contentType||fallbackType,size:head?head.size:null,checksum:null,fieldCaptureId:String(capture.id)});
  }
  return entries;
}

// Exact-match lookup against the manifest sources, so only objects the data references can be downloaded.
export async function isManifestObjectKey(key:string){
  if(!key)return false;
  return Boolean(await env.DB.prepare("SELECT 1 AS found FROM document_versions WHERE object_key=? UNION ALL SELECT 1 FROM field_captures WHERE audio_object_key=? OR attachment_object_key=? LIMIT 1").bind(key,key,key).first());
}
