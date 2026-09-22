import { env } from "cloudflare:workers";

function email(value:unknown){return typeof value==="string"?value.trim().toLowerCase():"";}

export async function POST(request:Request){
 const body=await request.json().catch(()=>({})) as Record<string,unknown>,address=email(body.email);if(!address.match(/^[^\s@]+@[^\s@]+\.[^\s@]+$/))return Response.json({error:"Enter a valid email address."},{status:400});
 await env.DB.batch([
  env.DB.prepare("INSERT INTO suppressions (email,reason,source,created_at,removed_at) VALUES (?,'Recipient unsubscribe','Public page',datetime('now'),NULL) ON CONFLICT(email) DO UPDATE SET reason='Recipient unsubscribe',source='Public page',created_at=datetime('now'),removed_at=NULL").bind(address),
  env.DB.prepare("UPDATE contacts SET subscribed=0,suppression_reason='Recipient unsubscribe',suppressed_at=datetime('now'),resend_synced_at=NULL,updated_at=datetime('now') WHERE email=?").bind(address),
  env.DB.prepare("INSERT INTO consent_events (email,status,reason,source,occurred_at) VALUES (?,'Unsubscribed','Recipient unsubscribe','Public page',datetime('now'))").bind(address)
 ]);
 return Response.json({ok:true});
}
