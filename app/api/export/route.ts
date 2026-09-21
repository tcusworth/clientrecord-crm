import { env } from "cloudflare:workers";

function csv(value:unknown){const text=value==null?"":String(value);return /[",\n]/.test(text)?`"${text.replaceAll('"','""')}"`:text;}
function download(name:string,headers:string[],rows:unknown[][]){const body=[headers,...rows].map(row=>row.map(csv).join(",")).join("\r\n");return new Response(body,{headers:{"content-type":"text/csv; charset=utf-8","content-disposition":`attachment; filename="${name}"`}});}

export async function GET(request:Request){
 const email=request.headers.get("oai-authenticated-user-email")?.toLowerCase(),allowed=String(env.CRM_ALLOWED_EMAILS||"tcusworth@gmail.com").toLowerCase().split(",").map(v=>v.trim());if(!request.headers.get("oai-authenticated-user-id")||!email||!allowed.includes(email))return Response.json({error:"Authorized sign-in is required."},{status:401});
 const type=new URL(request.url).searchParams.get("type")||"contacts";
 if(type==="contacts"){
  const result=await env.DB.prepare("SELECT first_name,last_name,email,company,title,phone,stage,tags,last_contact,next_follow_up,subscribed,suppression_reason,created_at FROM contacts ORDER BY last_name,first_name").all();
  return download("crm-contacts.csv",["First name","Last name","Email","Company","Title","Phone","Stage","Tags","Last contact","Next follow-up","Subscribed","Suppression reason","Created"],result.results.map((r:Record<string,unknown>)=>[r.first_name,r.last_name,r.email,r.company,r.title,r.phone,r.stage,JSON.parse(String(r.tags||"[]")).join("; "),r.last_contact,r.next_follow_up,Boolean(r.subscribed)?"Yes":"No",r.suppression_reason,r.created_at]));
 }
 if(type==="campaigns"){
  const result=await env.DB.prepare("SELECT name,subject,status,audience,recipient_count,delivered_count,opened_count,clicked_count,bounced_count,complained_count,scheduled_at,sent_at,created_at FROM campaigns ORDER BY created_at DESC").all();
  return download("crm-campaigns.csv",["Campaign","Subject","Status","Audience","Recipients","Delivered","Opened","Clicked","Bounced","Complained","Scheduled","Sent","Created"],result.results.map((r:Record<string,unknown>)=>[r.name,r.subject,r.status,r.audience,r.recipient_count,r.delivered_count,r.opened_count,r.clicked_count,r.bounced_count,r.complained_count,r.scheduled_at,r.sent_at,r.created_at]));
 }
 if(type==="activity"){
  const result=await env.DB.prepare("SELECT c.first_name||' '||c.last_name AS contact,c.email,a.type,a.note,a.happened_at FROM activities a JOIN contacts c ON c.id=a.contact_id ORDER BY a.happened_at DESC").all();
  return download("crm-activity.csv",["Contact","Email","Type","Note","Date"],result.results.map((r:Record<string,unknown>)=>[r.contact,r.email,r.type,r.note,r.happened_at]));
 }
 if(type==="recipients"){
  const result=await env.DB.prepare("SELECT c.name AS campaign,c.subject,e.recipient,e.type,e.occurred_at FROM campaign_events e JOIN campaigns c ON c.id=e.campaign_id ORDER BY e.occurred_at DESC").all();
  return download("crm-campaign-recipients.csv",["Campaign","Subject","Recipient","Event","Date"],result.results.map((r:Record<string,unknown>)=>[r.campaign,r.subject,r.recipient,r.type,r.occurred_at]));
 }
 if(type==="backup"){
  const tables=["contacts","activities","tasks","campaigns","campaign_events","segments","suppressions","consent_events","companies"];const data:Record<string,unknown>={exportedAt:new Date().toISOString()};for(const table of tables)data[table]=(await env.DB.prepare(`SELECT * FROM ${table}`).all()).results;return new Response(JSON.stringify(data,null,2),{headers:{"content-type":"application/json","content-disposition":"attachment; filename=crm-account-backup.json"}});
 }
 return Response.json({error:"Unknown export type."},{status:400});
}
