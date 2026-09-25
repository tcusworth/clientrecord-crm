import { env } from "cloudflare:workers";
import { apiKeyUser, audit, crmUser, type CRMUser } from "@/lib/crm-auth";
import { BACKUP_EXPORT_EXCLUDED_TABLES, exportableTables, isManifestObjectKey, objectManifest, quoteIdentifier } from "@/lib/backup-export";
import { csvCell } from "@/lib/csv";

// Owner-only full data export used to migrate off the current host (see scripts/export-from-live.mjs).
const MAX_PAGE=1000,DEFAULT_PAGE=500;
const noStore={"cache-control":"no-store","x-content-type-options":"nosniff"};
const json=(body:unknown,status=200)=>Response.json(body,{status,headers:noStore});
const plain=(value:unknown)=>value instanceof ArrayBuffer?Array.from(new Uint8Array(value)):ArrayBuffer.isView(value)?Array.from(new Uint8Array(value.buffer,value.byteOffset,value.byteLength)):value;
const plainRow=(row:Record<string,unknown>)=>Object.fromEntries(Object.entries(row).map(([key,value])=>[key,plain(value)]));
const safeFilename=(value:string)=>value.replace(/[^A-Za-z0-9._-]/g,"_").slice(0,180)||"export";

// A signed-in owner, or an API key that lists backups.export explicitly ("*" keys do not qualify). Admins and below never get in.
async function exporter(request:Request):Promise<{user:CRMUser;via:string}|{response:Response}>{
  const user=await crmUser(request);if(user?.role==="owner")return {user,via:"session"};
  const key=await apiKeyUser(request,"backups.export",{allowWildcard:false});if(key)return {user:key,via:key.id};
  const denied=Boolean(user)||/^Bearer\s+cr_live_/i.test(request.headers.get("authorization")||"");
  return {response:json({error:denied?"Owner access or an API key with the backups.export scope is required.":"Authorized sign-in is required."},denied?403:401)};
}

function pageParam(value:string|null,fallback:number,min:number,max:number){if(value===null||value==="")return fallback;if(!/^\d+$/.test(value))return null;const number=Number(value);return number>=min&&number<=max?number:null;}

export async function GET(request:Request){
  const access=await exporter(request);if("response" in access)return access.response;const {user,via}=access;
  try{
    const params=new URL(request.url).searchParams,part=params.get("part"),tableName=params.get("table"),objectKey=params.get("object");
    if(objectKey!==null){
      // Not audited per object: keys are only discoverable through the audited manifest/table reads, and a migration fetches thousands of them.
      if(!(await isManifestObjectKey(objectKey)))return json({error:"Object not found."},404);
      const object=await env.BUCKET.get(objectKey);if(!object)return json({error:"Stored object is unavailable."},404);
      return new Response(object.body,{headers:{...noStore,"content-type":"application/octet-stream","content-disposition":`attachment; filename="${safeFilename(objectKey.split("/").pop()||"")}"`}});
    }
    if(part==="manifest"){const objects=await objectManifest();await audit(user,"backup.export.manifest","backup_export",null,`Exported object manifest (${objects.length} objects)`,{via,objects:objects.length});return json({objects});}
    const tables=await exportableTables();
    if(part==="tables"){
      const list=[];for(const table of tables){const row=await env.DB.prepare(`SELECT COUNT(*) AS count FROM ${quoteIdentifier(table.name)}`).first<{count:number}>();list.push({name:table.name,rows:Number(row?.count||0),columns:table.columns});}
      await audit(user,"backup.export.tables","backup_export",null,`Listed ${list.length} exportable tables`,{via,tables:list.length});
      return json({tables:list,excluded:Object.entries(BACKUP_EXPORT_EXCLUDED_TABLES).map(([name,reason])=>({name,reason}))});
    }
    if(tableName!==null){
      const table=tables.find(item=>item.name===tableName);if(!table)return json({error:"Unknown or non-exportable table."},400);const from=quoteIdentifier(table.name),format=params.get("format")||"json";
      if(format==="csv"){
        const lines=[table.columns.map(csvCell).join(",")];for(let offset=0;;offset+=MAX_PAGE){const rows=(await env.DB.prepare(`SELECT * FROM ${from} ORDER BY rowid LIMIT ? OFFSET ?`).bind(MAX_PAGE,offset).all<Record<string,unknown>>()).results;for(const row of rows)lines.push(table.columns.map(column=>csvCell(plain(row[column]))).join(","));if(rows.length<MAX_PAGE)break;}
        await audit(user,"backup.export.csv","backup_export",table.name,`Exported ${table.name} as CSV`,{via,rows:lines.length-1});
        return new Response(lines.join("\r\n"),{headers:{...noStore,"content-type":"text/csv; charset=utf-8","content-disposition":`attachment; filename="${safeFilename(table.name)}.csv"`}});
      }
      if(format!=="json")return json({error:"format must be json or csv."},400);
      const offset=pageParam(params.get("offset"),0,0,Number.MAX_SAFE_INTEGER),limit=pageParam(params.get("limit"),DEFAULT_PAGE,1,MAX_PAGE);if(offset===null||limit===null)return json({error:`offset must be a non-negative integer and limit 1-${MAX_PAGE}.`},400);
      // rowid order is stable across pages; one extra row tells us whether another page exists.
      const rows=(await env.DB.prepare(`SELECT * FROM ${from} ORDER BY rowid LIMIT ? OFFSET ?`).bind(limit+1,offset).all<Record<string,unknown>>()).results;
      if(offset===0)await audit(user,"backup.export.table","backup_export",table.name,`Exported table ${table.name}`,{via});
      return json({table:table.name,columns:table.columns,rows:rows.slice(0,limit).map(plainRow),offset,nextOffset:rows.length>limit?offset+limit:null});
    }
    return json({error:"Use ?part=tables, ?part=manifest, ?table=<name>[&format=csv] or ?object=<key>."},400);
  }catch(error){console.error("Backup export failed",error);return json({error:"The export could not be produced."},500);}
}
