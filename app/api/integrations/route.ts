import { env } from "cloudflare:workers";
import { audit, can, crmUser, sha256 } from "@/lib/crm-auth";
import { googleConfigured } from "@/lib/google";
import { importMeetilyEvent } from "@/lib/meetily-webhook";
import { microsoftConfigured } from "@/lib/microsoft";

type Row=Record<string,unknown>;
const clean=(value:unknown,max=240)=>String(value??"").trim().slice(0,max);
function token(prefix:string){const bytes=crypto.getRandomValues(new Uint8Array(30));let raw="";for(const byte of bytes)raw+=String.fromCharCode(byte);return `${prefix}${btoa(raw).replaceAll("+","-").replaceAll("/","_").replaceAll("=","")}`;}

export async function GET(request:Request){
  const user=await crmUser(request);if(!user)return Response.json({error:"Sign in is required."},{status:401});
  const accountRows=(await env.DB.prepare("SELECT provider,account_email AS accountEmail,sync_email AS syncEmail,sync_calendar AS syncCalendar,auto_tasks AS autoTasks,last_synced_at AS lastSyncedAt FROM integration_accounts WHERE provider IN ('microsoft','google')").all<Row>()).results;
  const one=(provider:string)=>{const row=accountRows.find(item=>item.provider===provider);return {provider,configured:provider==="microsoft"?microsoftConfigured():googleConfigured(),connected:Boolean(row),accountEmail:row?.accountEmail||"",syncEmail:row?Boolean(row.syncEmail):true,syncCalendar:row?Boolean(row.syncCalendar):true,autoTasks:row?Boolean(row.autoTasks):true,lastSyncedAt:row?.lastSyncedAt||null};};
  if(!can(user,"integrations.manage"))return Response.json({accounts:[one("microsoft"),one("google")],meetily:null});
  const [keys,events,deals]=await Promise.all([
    env.DB.prepare("SELECT scopes FROM api_keys WHERE revoked_at IS NULL AND (expires_at IS NULL OR expires_at>datetime('now'))").all<Row>(),
    env.DB.prepare("SELECT id,external_id AS externalId,event_type AS eventType,subject,occurred_at AS occurredAt,status,deal_id AS dealId,meeting_id AS meetingId,error,duplicate_count AS duplicateCount,received_at AS receivedAt,processed_at AS processedAt FROM meetily_webhook_events ORDER BY received_at DESC LIMIT 100").all<Row>(),
    env.DB.prepare("SELECT id,name,company,stage,owner FROM deals WHERE status='Open' ORDER BY updated_at DESC,name").all<Row>(),
  ]);
  const tokenExists=keys.results.some(row=>String(row.scopes||"").split(",").map(value=>value.trim()).some(scope=>scope==="*"||scope==="meetings.import"));
  return Response.json({accounts:[one("microsoft"),one("google")],meetily:{endpoint:`${new URL(request.url).origin}/api/integrations/meetily/meetings`,tokenExists,events:events.results,deals:deals.results}});
}

export async function POST(request:Request){
  const user=await crmUser(request);if(!user)return Response.json({error:"Sign in is required."},{status:401});
  if(!can(user,"integrations.manage"))return Response.json({error:"Integration access is required."},{status:403});
  const body=await request.json().catch(()=>({})) as Row,action=clean(body.action);
  try{
    if(action==="createMeetilyToken"){
      const raw=token("cr_live_"),id=crypto.randomUUID(),name="Meetily connector";
      await env.DB.prepare("INSERT INTO api_keys(id,name,key_hash,key_prefix,scopes,expires_at,created_by,created_at) VALUES (?,?,?,?,?,NULL,?,datetime('now'))").bind(id,name,await sha256(raw),raw.slice(0,16),"meetings.import",user.email).run();
      await audit(user,action,"api_key",id,"Created Meetily connector token",{name,scopes:"meetings.import"});
      return Response.json({id,key:raw,name,scopes:"meetings.import"},{status:201});
    }
    if(action==="associateMeetilyEvent"){
      const eventId=clean(body.eventId),dealId=Number(body.dealId);if(!eventId||!Number.isInteger(dealId)||dealId<1)return Response.json({error:"Choose a valid meeting and deal."},{status:400});
      return Response.json(await importMeetilyEvent(eventId,dealId,user));
    }
    if(action==="dismissMeetilyEvent"){
      const eventId=clean(body.eventId);if(!eventId)return Response.json({error:"Choose a meeting event."},{status:400});
      await env.DB.prepare("UPDATE meetily_webhook_events SET status='Dismissed',processed_at=datetime('now'),last_seen_at=datetime('now') WHERE id=?").bind(eventId).run();
      await audit(user,action,"meetily_event",eventId,"Dismissed unmatched Meetily meeting");return Response.json({status:"Dismissed"});
    }
    const provider=clean(body.provider);
    if(!["microsoft","google"].includes(provider))return Response.json({error:"Unknown provider."},{status:400});
    if(action==="savePreferences"){await env.DB.prepare("UPDATE integration_accounts SET sync_email=?,sync_calendar=?,auto_tasks=?,updated_at=datetime('now') WHERE provider=?").bind(body.syncEmail?1:0,body.syncCalendar?1:0,body.autoTasks?1:0,provider).run();await audit(user,"integration.preferences","integration",provider,"Updated synchronization preferences",{syncEmail:body.syncEmail,syncCalendar:body.syncCalendar,autoTasks:body.autoTasks});return Response.json({status:"saved"});}
    if(action==="disconnect"){await env.DB.prepare("DELETE FROM integration_accounts WHERE provider=?").bind(provider).run();await audit(user,"integration.disconnect","integration",provider,`Disconnected ${provider}`);return Response.json({status:"disconnected"});}
    return Response.json({error:"Unknown action."},{status:400});
  }catch(error){console.error(error);return Response.json({error:error instanceof Error?error.message:"The integration action failed."},{status:500});}
}
