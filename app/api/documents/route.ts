import { env } from "cloudflare:workers";
import { audit, can, crmUser } from "@/lib/crm-auth";

type Row=Record<string,unknown>;
const clean=(value:unknown,max=500)=>String(value??"").trim().slice(0,max);
const documentCategories=["Proposal","Contract","NDA","Scope","Presentation","Correspondence","Quote","Technical","Other"];
const safeFilename=(name:string)=>name.replace(/[^a-zA-Z0-9._ -]/g,"_").slice(0,180)||"document";
const contentTypes=new Set(["application/pdf","image/png","image/jpeg","image/webp","text/plain","text/csv","application/vnd.openxmlformats-officedocument.wordprocessingml.document","application/vnd.openxmlformats-officedocument.spreadsheetml.sheet","application/vnd.openxmlformats-officedocument.presentationml.presentation"]);
async function digest(buffer:ArrayBuffer){const hash=await crypto.subtle.digest("SHA-256",buffer);return Array.from(new Uint8Array(hash)).map(v=>v.toString(16).padStart(2,"0")).join("")}
async function auth(request:Request,permission:"documents.view"|"documents.upload"|"records.delete"="documents.view"){
  const user=await crmUser(request);if(!user)return {response:Response.json({error:"Sign in is required."},{status:401}),user:null};
  if(!can(user,permission))return {response:Response.json({error:"You do not have permission for client documents."},{status:403}),user:null};
  return {response:null,user};
}
async function record(id:string){return env.DB.prepare(`SELECT d.*,v.id AS version_id,v.filename,v.content_type,v.size,v.object_key,v.checksum,v.uploaded_by,v.uploaded_at
  FROM client_documents d JOIN document_versions v ON v.document_id=d.id AND v.version=d.latest_version WHERE d.id=?`).bind(id).first<Row>()}
function headers(filename:string,type:string,inline:boolean){const disposition=`${inline?"inline":"attachment"}; filename="${safeFilename(filename).replaceAll('"',"")}"`;return {"content-type":type||"application/octet-stream","content-disposition":disposition,"x-content-type-options":"nosniff","cache-control":"private, no-store"}}

export async function GET(request:Request){
  const access=await auth(request);if(!access.user)return access.response;const url=new URL(request.url),documentId=clean(url.searchParams.get("id"),80);
  try{
    if(documentId){
      const doc=await record(documentId);if(!doc)return Response.json({error:"Document not found."},{status:404});
      if(doc.sensitive&&!can(access.user,"documents.manage_sensitive"))return Response.json({error:"Sensitive-document permission is required."},{status:403});
      if(url.searchParams.get("action")==="versions"){
        const versions=await env.DB.prepare("SELECT id,version,filename,content_type AS contentType,size,checksum,uploaded_by AS uploadedBy,uploaded_at AS uploadedAt FROM document_versions WHERE document_id=? ORDER BY version DESC").bind(documentId).all();return Response.json({document:doc,versions:versions.results});
      }
      const version=Number(url.searchParams.get("version"))||Number(doc.latest_version),row=version===Number(doc.latest_version)?doc:await env.DB.prepare("SELECT d.sensitive,v.* FROM client_documents d JOIN document_versions v ON v.document_id=d.id WHERE d.id=? AND v.version=?").bind(documentId,version).first<Row>();if(!row)return Response.json({error:"Document version not found."},{status:404});
      const object=await env.BUCKET.get(String(row.object_key));if(!object)return Response.json({error:"Stored file is unavailable."},{status:404});
      const type=String(row.content_type||"application/octet-stream"),preview=url.searchParams.get("preview")==="1"&&(type==="application/pdf"||type.startsWith("image/")||type.startsWith("text/"));return new Response(object.body,{headers:headers(String(row.filename),type,preview)});
    }
    const sensitive=can(access.user,"documents.manage_sensitive")?1:0,entityType=clean(url.searchParams.get("entityType"),20),entityId=Number(url.searchParams.get("entityId"))||0,archived=url.searchParams.get("archived")==="1";
    let predicate="(?=1 OR d.sensitive=0) AND d.status=?",args:(string|number|null)[]=[sensitive,archived?"Archived":"Active"];
    if(["company","contact","deal"].includes(entityType)&&entityId){predicate+=` AND d.${entityType}_id=?`;args.push(entityId)}
    const result=await env.DB.prepare(`SELECT d.*,v.filename,v.content_type AS contentType,v.size,v.uploaded_by AS uploadedBy,v.uploaded_at AS uploadedAt,c.name AS companyName,ct.first_name||' '||ct.last_name AS contactName,x.name AS dealName
      FROM client_documents d JOIN document_versions v ON v.document_id=d.id AND v.version=d.latest_version LEFT JOIN companies c ON c.id=d.company_id LEFT JOIN contacts ct ON ct.id=d.contact_id LEFT JOIN deals x ON x.id=d.deal_id WHERE ${predicate} ORDER BY d.updated_at DESC LIMIT 250`).bind(...args).all();
    return Response.json({documents:result.results,categories:documentCategories,permissions:{upload:can(access.user,"documents.upload"),delete:can(access.user,"records.delete"),sensitive:can(access.user,"documents.manage_sensitive")}});
  }catch(error){console.error(error);return Response.json({error:"Client documents could not be loaded."},{status:503})}
}

export async function POST(request:Request){
  const access=await auth(request,"documents.upload");if(!access.user)return access.response;
  try{
    if(!env.BUCKET)return Response.json({error:"Secure document storage is not configured."},{status:503});const form=await request.formData(),file=form.get("file");if(!(file instanceof File)||!file.size)return Response.json({error:"Choose a file to upload."},{status:400});if(file.size>25*1024*1024)return Response.json({error:"Files must be 25 MB or smaller."},{status:413});
    const type=file.type||"application/octet-stream";if(!contentTypes.has(type))return Response.json({error:"Upload a PDF, image, text, CSV, Word, Excel, or PowerPoint file."},{status:415});const category=clean(form.get("category"),60)||"Correspondence";if(!documentCategories.includes(category))return Response.json({error:"Choose a valid document category."},{status:400});
    const existingId=clean(form.get("documentId"),80),now=new Date().toISOString(),buffer=await file.arrayBuffer(),checksum=await digest(buffer);let documentId=existingId,version=1,title=clean(form.get("title"),240)||file.name;
    let companyId:number|null=null,contactId:number|null=null,dealId:number|null=null,sensitive=false;
    if(existingId){const existing=await record(existingId);if(!existing)return Response.json({error:"Document not found."},{status:404});if(existing.sensitive&&!can(access.user,"documents.manage_sensitive"))return Response.json({error:"Sensitive-document permission is required."},{status:403});version=Number(existing.latest_version)+1;title=String(existing.title);companyId=existing.company_id?Number(existing.company_id):null;contactId=existing.contact_id?Number(existing.contact_id):null;dealId=existing.deal_id?Number(existing.deal_id):null;sensitive=Boolean(existing.sensitive)}
    else{documentId=crypto.randomUUID();const entityType=clean(form.get("entityType"),20),entityId=Number(form.get("entityId"));if(!["company","contact","deal"].includes(entityType)||!Number.isInteger(entityId)||entityId<1)return Response.json({error:"Associate the document with a company, contact, or deal."},{status:400});const table=entityType==="company"?"companies":entityType==="contact"?"contacts":"deals",found=await env.DB.prepare(`SELECT id FROM ${table} WHERE id=?`).bind(entityId).first();if(!found)return Response.json({error:"The selected CRM record was not found."},{status:404});if(entityType==="company")companyId=entityId;if(entityType==="contact")contactId=entityId;if(entityType==="deal")dealId=entityId;sensitive=form.get("sensitive")==="on"||form.get("sensitive")==="true";if(sensitive&&!can(access.user,"documents.manage_sensitive"))return Response.json({error:"Sensitive-document permission is required."},{status:403})}
    const versionId=crypto.randomUUID(),objectKey=`client-documents/${documentId}/v${version}-${versionId}`;await env.BUCKET.put(objectKey,buffer,{httpMetadata:{contentType:type},customMetadata:{documentId,version:String(version),checksum}});
    try{if(existingId)await env.DB.batch([env.DB.prepare("INSERT INTO document_versions(id,document_id,version,object_key,filename,content_type,size,checksum,uploaded_by,uploaded_at) VALUES (?,?,?,?,?,?,?,?,?,?)").bind(versionId,documentId,version,objectKey,safeFilename(file.name),type,file.size,checksum,access.user.email,now),env.DB.prepare("UPDATE client_documents SET latest_version=?,status='Active',updated_at=?,archived_at=NULL WHERE id=?").bind(version,now,documentId)]);else await env.DB.batch([env.DB.prepare("INSERT INTO client_documents(id,company_id,contact_id,deal_id,title,category,status,sensitive,latest_version,created_by,created_at,updated_at) VALUES (?,?,?,?,?,?,'Active',?,1,?,?,?)").bind(documentId,companyId,contactId,dealId,title,category,sensitive?1:0,access.user.email,now,now),env.DB.prepare("INSERT INTO document_versions(id,document_id,version,object_key,filename,content_type,size,checksum,uploaded_by,uploaded_at) VALUES (?,?,?,?,?,?,?,?,?,?)").bind(versionId,documentId,1,objectKey,safeFilename(file.name),type,file.size,checksum,access.user.email,now)]);}catch(error){await env.BUCKET.delete(objectKey);throw error}
    await audit(access.user,existingId?"document.version":"document.upload","client_document",documentId,existingId?`Uploaded version ${version}`:"Uploaded client document",{title,category,companyId,contactId,dealId,version,size:file.size,sensitive});return Response.json({id:documentId,version},{status:201});
  }catch(error){console.error(error);return Response.json({error:error instanceof Error?error.message:"The document could not be uploaded."},{status:400})}
}

export async function PATCH(request:Request){
  const access=await auth(request,"documents.upload");if(!access.user)return access.response;
  try{const body=await request.json() as Row,documentId=clean(body.id,80),doc=await record(documentId);if(!doc)return Response.json({error:"Document not found."},{status:404});if(doc.sensitive&&!can(access.user,"documents.manage_sensitive"))return Response.json({error:"Sensitive-document permission is required."},{status:403});const action=clean(body.action,30),now=new Date().toISOString();
    if(action==="rename"){const title=clean(body.title,240);if(!title)throw new Error("Enter a document name.");await env.DB.prepare("UPDATE client_documents SET title=?,category=?,updated_at=? WHERE id=?").bind(title,documentCategories.includes(clean(body.category,60))?clean(body.category,60):String(doc.category),now,documentId).run();await audit(access.user,"document.rename","client_document",documentId,"Renamed client document",{before:{title:doc.title,category:doc.category},after:{title,category:body.category}})}
    else if(action==="archive"||action==="restore"){const status=action==="archive"?"Archived":"Active";await env.DB.prepare("UPDATE client_documents SET status=?,archived_at=?,updated_at=? WHERE id=?").bind(status,status==="Archived"?now:null,now,documentId).run();await audit(access.user,`document.${action}`,"client_document",documentId,`${action==="archive"?"Archived":"Restored"} client document`,{status})}
    else throw new Error("Unknown document action.");return Response.json({ok:true});
  }catch(error){return Response.json({error:error instanceof Error?error.message:"The document could not be changed."},{status:400})}
}

export async function DELETE(request:Request){
  const access=await auth(request,"records.delete");if(!access.user)return access.response;
  try{const id=clean(new URL(request.url).searchParams.get("id"),80),doc=await record(id);if(!doc)return Response.json({error:"Document not found."},{status:404});if(doc.sensitive&&!can(access.user,"documents.manage_sensitive"))return Response.json({error:"Sensitive-document permission is required."},{status:403});const versions=(await env.DB.prepare("SELECT object_key FROM document_versions WHERE document_id=?").bind(id).all<Row>()).results;for(const version of versions)await env.BUCKET.delete(String(version.object_key));await env.DB.batch([env.DB.prepare("DELETE FROM document_versions WHERE document_id=?").bind(id),env.DB.prepare("DELETE FROM client_documents WHERE id=?").bind(id)]);await audit(access.user,"document.delete","client_document",id,"Deleted client document and all versions",{title:doc.title,versions:versions.length});return Response.json({ok:true});
  }catch(error){return Response.json({error:error instanceof Error?error.message:"The document could not be deleted."},{status:400})}
}
