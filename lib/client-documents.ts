import { env } from "cloudflare:workers";

export const documentContentTypes=new Set(["application/pdf","image/png","image/jpeg","image/webp","text/plain","text/csv","application/vnd.openxmlformats-officedocument.wordprocessingml.document","application/vnd.openxmlformats-officedocument.spreadsheetml.sheet","application/vnd.openxmlformats-officedocument.presentationml.presentation"]);
// Only these render in the browser; everything else downloads. Never add HTML, SVG, or XML types here.
export const inlinePreviewTypes=new Set(["application/pdf","image/png","image/jpeg","image/webp","text/plain"]);
// Sender-declared types (e.g. from synced email) are untrusted: anything outside the allowlist is stored as opaque bytes.
export function safeContentType(value:unknown){const type=String(value??"").split(";")[0].trim().toLowerCase();return documentContentTypes.has(type)?type:"application/octet-stream"}
function bytesFromBase64(value:string){const normalized=value.replace(/-/g,"+").replace(/_/g,"/");const binary=atob(normalized);return Uint8Array.from(binary,char=>char.charCodeAt(0))}
async function checksum(bytes:ArrayBuffer|Uint8Array){const source=bytes instanceof Uint8Array?bytes:new Uint8Array(bytes),copy=new Uint8Array(source.byteLength);copy.set(source);const hash=await crypto.subtle.digest("SHA-256",copy);return Array.from(new Uint8Array(hash)).map(v=>v.toString(16).padStart(2,"0")).join("")}
export async function saveCommunicationAttachment(input:{filename:string;contentType:string;bytes:ArrayBuffer|Uint8Array;dealId:number;contactId?:number|null;companyId?:number|null;actor:string;source:string}){
  const size=input.bytes.byteLength;if(!size||size>25*1024*1024||!env.BUCKET)return null;const documentId=crypto.randomUUID(),versionId=crypto.randomUUID(),now=new Date().toISOString(),objectKey=`client-documents/${documentId}/v1-${versionId}`,hash=await checksum(input.bytes),filename=input.filename.replace(/[^a-zA-Z0-9._ -]/g,"_").slice(0,180)||"attachment",contentType=safeContentType(input.contentType);
  await env.BUCKET.put(objectKey,input.bytes,{httpMetadata:{contentType},customMetadata:{documentId,version:"1",checksum:hash,source:input.source}});
  try{await env.DB.batch([
    env.DB.prepare("INSERT INTO client_documents(id,company_id,contact_id,deal_id,title,category,status,sensitive,latest_version,created_by,created_at,updated_at) VALUES (?,?,?,?,?,'Correspondence','Active',0,1,?,?,?)").bind(documentId,input.companyId||null,input.contactId||null,input.dealId,filename,input.actor,now,now),
    env.DB.prepare("INSERT INTO document_versions(id,document_id,version,object_key,filename,content_type,size,checksum,uploaded_by,uploaded_at) VALUES (?,?,1,?,?,?,?,?,?,?)").bind(versionId,documentId,objectKey,filename,contentType,size,hash,input.actor,now),
  ])}catch(error){await env.BUCKET.delete(objectKey);throw error}return documentId;
}
export { bytesFromBase64 };
