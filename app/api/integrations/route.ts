import { env } from "cloudflare:workers";
import { audit, can, crmUser, sha256 } from "@/lib/crm-auth";
import { accountById, allPersonalAccounts, canConnectOwn, canManageAll, ownAccount, type IntegrationAccount } from "@/lib/integrations/accounts";
import { googleConfigured, revokeGoogleToken } from "@/lib/google";
import { importMeetilyEvent } from "@/lib/meetily-webhook";
import { decryptToken, microsoftConfigured } from "@/lib/microsoft";
import { quickbooksConfigured, revokeQuickbooksToken } from "@/lib/quickbooks";

type Row=Record<string,unknown>;
const clean=(value:unknown,max=240)=>String(value??"").trim().slice(0,max);
// Best-effort provider revocation; a failure is logged and never blocks the local disconnect. Microsoft has no token-revocation endpoint for this authorization-code flow, so its tokens are only deleted locally.
async function revokeAtProvider(provider:string,id?:number){
  if(provider==="microsoft")return "not-supported";
  const row=id?await env.DB.prepare("SELECT access_token,refresh_token FROM integration_accounts WHERE id=?").bind(id).first<Row>():await env.DB.prepare("SELECT access_token,refresh_token FROM integration_accounts WHERE provider=? AND user_email=''").bind(provider).first<Row>();if(!row)return "not-connected";
  try{const token=await decryptToken(String(row.refresh_token||row.access_token));if(provider==="google")await revokeGoogleToken(token);else await revokeQuickbooksToken(token);return "revoked";}
  catch(error){console.error(`${provider} token revocation failed`,error);return "failed";}
}
// Token-free view of a personal account; userName comes from one team_members lookup for the whole list.
const accountView=(row:IntegrationAccount,names:Map<string,string>)=>({id:row.id,provider:row.provider,userEmail:row.user_email,userName:names.get(row.user_email.toLowerCase())||row.user_email,accountEmail:row.account_email,lastSyncedAt:row.last_synced_at,status:row.status,syncEmail:Boolean(row.sync_email),syncCalendar:Boolean(row.sync_calendar),autoTasks:Boolean(row.auto_tasks)});
async function teamNames(){return new Map((await env.DB.prepare("SELECT lower(email) AS email,name FROM team_members").all<{email:string;name:string}>()).results.filter(row=>String(row.name||"").trim()).map(row=>[row.email,String(row.name).trim()] as [string,string]));}
function token(prefix:string){const bytes=crypto.getRandomValues(new Uint8Array(30));let raw="";for(const byte of bytes)raw+=String.fromCharCode(byte);return `${prefix}${btoa(raw).replaceAll("+","-").replaceAll("/","_").replaceAll("=","")}`;}

export async function GET(request:Request){
  const user=await crmUser(request);if(!user)return Response.json({error:"Sign in is required."},{status:401});
  const accountRows=(await env.DB.prepare("SELECT provider,account_email AS accountEmail,sync_email AS syncEmail,sync_calendar AS syncCalendar,auto_tasks AS autoTasks,last_synced_at AS lastSyncedAt FROM integration_accounts WHERE provider='quickbooks' AND user_email=''").all<Row>()).results;
  const [mineRows,allRows,names]=await Promise.all([Promise.all([ownAccount("microsoft",user.email),ownAccount("google",user.email)]),canManageAll(user)?allPersonalAccounts():Promise.resolve(null),teamNames()]);
  const mine=mineRows.filter((row):row is IntegrationAccount=>Boolean(row));
  const personal={mine:mine.map(row=>accountView(row,names)),team:allRows?allRows.map(row=>accountView(row,names)):null};
  const one=(provider:string)=>{const own=mine.find(item=>item.provider===provider),row=provider==="quickbooks"?accountRows[0]:own&&{accountEmail:own.account_email,syncEmail:own.sync_email,syncCalendar:own.sync_calendar,autoTasks:own.auto_tasks,lastSyncedAt:own.last_synced_at};return {provider,configured:provider==="microsoft"?microsoftConfigured():provider==="quickbooks"?quickbooksConfigured():googleConfigured(),connected:Boolean(row),accountEmail:row?.accountEmail||"",syncEmail:row?Boolean(row.syncEmail):true,syncCalendar:row?Boolean(row.syncCalendar):true,autoTasks:row?Boolean(row.autoTasks):true,lastSyncedAt:row?.lastSyncedAt||null};};
  if(!can(user,"integrations.manage"))return Response.json({accounts:[one("microsoft"),one("google"),one("quickbooks")],meetily:null,personal});
  const [keys,events,deals]=await Promise.all([
    env.DB.prepare("SELECT scopes FROM api_keys WHERE revoked_at IS NULL AND (expires_at IS NULL OR expires_at>datetime('now'))").all<Row>(),
    env.DB.prepare("SELECT id,external_id AS externalId,event_type AS eventType,subject,occurred_at AS occurredAt,status,deal_id AS dealId,meeting_id AS meetingId,error,duplicate_count AS duplicateCount,received_at AS receivedAt,processed_at AS processedAt FROM meetily_webhook_events ORDER BY received_at DESC LIMIT 100").all<Row>(),
    env.DB.prepare("SELECT id,name,company,stage,owner FROM deals WHERE status='Open' ORDER BY updated_at DESC,name").all<Row>(),
  ]);
  const tokenExists=keys.results.some(row=>String(row.scopes||"").split(",").map(value=>value.trim()).some(scope=>scope==="*"||scope==="meetings.import"));
  return Response.json({accounts:[one("microsoft"),one("google"),one("quickbooks")],personal,meetily:{endpoint:`${new URL(request.url).origin}/api/integrations/meetily/meetings`,tokenExists,events:events.results,deals:deals.results}});
}

export async function POST(request:Request){
  const user=await crmUser(request);if(!user)return Response.json({error:"Sign in is required."},{status:401});
  const body=await request.json().catch(()=>({})) as Row,action=clean(body.action);
  try{
    // Personal Google/Microsoft accounts: owners (records.edit) act on their own row, integrations.manage on any.
    if((action==="savePreferences"||action==="disconnect")&&!["quickbooks"].includes(clean(body.provider))){
      const id=Number(body.id),account=Number.isInteger(id)&&id>0?await accountById(id):null;
      if(!account||!["google","microsoft"].includes(account.provider))return Response.json({error:"Connection not found."},{status:404});
      if(user.id.startsWith("api:")||!canManageAll(user)&&!(canConnectOwn(user)&&account.user_email===user.email.trim().toLowerCase()))return Response.json({error:"Integration access is required."},{status:403});
      if(action==="savePreferences"){await env.DB.prepare("UPDATE integration_accounts SET sync_email=?,sync_calendar=?,auto_tasks=?,updated_at=datetime('now') WHERE id=?").bind(body.syncEmail?1:0,body.syncCalendar?1:0,body.autoTasks?1:0,id).run();await audit(user,"integration.preferences","integration",id,`Updated ${account.provider} synchronization preferences`,{provider:account.provider,userEmail:account.user_email,syncEmail:body.syncEmail,syncCalendar:body.syncCalendar,autoTasks:body.autoTasks});return Response.json({status:"saved"});}
      const revocation=await revokeAtProvider(account.provider,id);await env.DB.prepare("DELETE FROM integration_accounts WHERE id=?").bind(id).run();await audit(user,"integration.disconnect","integration",id,`Disconnected ${account.provider} for ${account.user_email}`,{provider:account.provider,userEmail:account.user_email,by:user.email,revocation});return Response.json({status:"disconnected",revocation});
    }
    if(!can(user,"integrations.manage"))return Response.json({error:"Integration access is required."},{status:403});
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
    if(provider!=="quickbooks")return Response.json({error:"Unknown provider."},{status:400});
    if(action==="savePreferences"){await env.DB.prepare("UPDATE integration_accounts SET sync_email=?,sync_calendar=?,auto_tasks=?,updated_at=datetime('now') WHERE provider=? AND user_email=''").bind(body.syncEmail?1:0,body.syncCalendar?1:0,body.autoTasks?1:0,provider).run();await audit(user,"integration.preferences","integration",provider,"Updated synchronization preferences",{syncEmail:body.syncEmail,syncCalendar:body.syncCalendar,autoTasks:body.autoTasks});return Response.json({status:"saved"});}
    if(action==="disconnect"){const revocation=await revokeAtProvider(provider);await env.DB.prepare("DELETE FROM integration_accounts WHERE provider=? AND user_email=''").bind(provider).run();await audit(user,"integration.disconnect","integration",provider,`Disconnected ${provider}`,{revocation});return Response.json({status:"disconnected",revocation});}
    return Response.json({error:"Unknown action."},{status:400});
  }catch(error){console.error(error);return Response.json({error:error instanceof Error?error.message:"The integration action failed."},{status:500});}
}
