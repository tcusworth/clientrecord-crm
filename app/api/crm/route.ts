import { env } from "cloudflare:workers";
import { fromEmail, resend, resendConfigured } from "@/lib/resend";

function clean(value: unknown, fallback = "") { return typeof value === "string" ? value.trim() : fallback; }
function signedIn(request: Request) { const id=request.headers.get("oai-authenticated-user-id"),email=request.headers.get("oai-authenticated-user-email"); return id?{id,email:email||"Signed-in owner"}:null; }
type SegmentRule={id:number;name:string;stage:string;tag:string;company:string;subscription:string;inactivityDays:number};
function audienceMatch(contact: Record<string, unknown>, audience: string, segment?: SegmentRule|null) {
  if (!Boolean(contact.subscribed)) return false;
  if(segment){const tags=contact.tags as string[];if(segment.stage!=="Any"&&contact.stage!==segment.stage)return false;if(segment.tag&&!tags.some(tag=>tag.toLowerCase()===segment.tag.toLowerCase()))return false;if(segment.company&&!String(contact.company).toLowerCase().includes(segment.company.toLowerCase()))return false;if(segment.inactivityDays>0){const cutoff=Date.now()-segment.inactivityDays*86400000;if(contact.lastContact&&new Date(String(contact.lastContact)).getTime()>cutoff)return false;}return true;}
  if (audience === "Customers only") return contact.stage === "Customer";
  if (audience === "Prospects and opportunities") return contact.stage === "Prospect" || contact.stage === "Opportunity";
  return true;
}
async function contactRows() {
  const result = await env.DB.prepare("SELECT id, first_name AS firstName, last_name AS lastName, email, company, title, phone, stage, tags, last_contact AS lastContact, next_follow_up AS nextFollowUp, subscribed, suppression_reason AS suppressionReason, suppressed_at AS suppressedAt, resend_id AS resendId, resend_synced_at AS resendSyncedAt, created_at AS createdAt, updated_at AS updatedAt FROM contacts ORDER BY last_name, first_name").all();
  return result.results.map((c: Record<string, unknown>) => ({ ...c, tags: JSON.parse(String(c.tags || "[]")), subscribed: Boolean(c.subscribed) }));
}
async function campaignRow(id: number) {
  return await env.DB.prepare("SELECT id, name, subject, preview_text AS previewText, html, text_body AS textBody, status, audience, recipient_count AS recipientCount, resend_segment_id AS resendSegmentId, resend_broadcast_id AS resendBroadcastId, scheduled_at AS scheduledAt, sent_at AS sentAt, delivered_count AS deliveredCount, opened_count AS openedCount, clicked_count AS clickedCount, bounced_count AS bouncedCount, complained_count AS complainedCount, created_at AS createdAt, updated_at AS updatedAt FROM campaigns WHERE id=?").bind(id).first<Record<string, unknown>>();
}
async function readAll(account:{id:string;email:string}) {
  const [contacts, activities, tasks, campaigns, segments, suppressions, campaignEvents] = await Promise.all([
    contactRows(),
    env.DB.prepare("SELECT a.id, a.contact_id AS contactId, a.type, a.note, a.happened_at AS happenedAt, c.first_name || ' ' || c.last_name AS contactName FROM activities a JOIN contacts c ON c.id = a.contact_id ORDER BY a.happened_at DESC LIMIT 100").all(),
    env.DB.prepare("SELECT t.id, t.contact_id AS contactId, t.title, t.due_date AS dueDate, t.completed, c.first_name || ' ' || c.last_name AS contactName FROM tasks t JOIN contacts c ON c.id = t.contact_id ORDER BY t.completed, t.due_date").all(),
    env.DB.prepare("SELECT id, name, subject, preview_text AS previewText, html, text_body AS textBody, status, audience, recipient_count AS recipientCount, resend_segment_id AS resendSegmentId, resend_broadcast_id AS resendBroadcastId, scheduled_at AS scheduledAt, sent_at AS sentAt, delivered_count AS deliveredCount, opened_count AS openedCount, clicked_count AS clickedCount, bounced_count AS bouncedCount, complained_count AS complainedCount, created_at AS createdAt, updated_at AS updatedAt FROM campaigns ORDER BY created_at DESC").all(),
    env.DB.prepare("SELECT id,name,stage,tag,company,subscription,inactivity_days AS inactivityDays,created_at AS createdAt,updated_at AS updatedAt FROM segments ORDER BY name").all(),
    env.DB.prepare("SELECT id,email,reason,source,created_at AS createdAt FROM suppressions WHERE removed_at IS NULL ORDER BY created_at DESC").all(),
    env.DB.prepare("SELECT e.id,e.campaign_id AS campaignId,e.type,e.recipient,e.occurred_at AS occurredAt,c.name AS campaignName,c.subject FROM campaign_events e JOIN campaigns c ON c.id=e.campaign_id ORDER BY e.occurred_at DESC LIMIT 500").all(),
  ]);
  return { contacts, activities: activities.results, tasks: tasks.results.map((t: Record<string, unknown>) => ({ ...t, completed: Boolean(t.completed) })), campaigns: campaigns.results, segments:segments.results, suppressions:suppressions.results, campaignEvents:campaignEvents.results, account, integration: { connected: resendConfigured(), fromEmail: env.RESEND_FROM_EMAIL || null, webhookReady: Boolean(env.RESEND_WEBHOOK_SECRET) } };
}
async function syncCampaign(id: number) {
  const campaign = await campaignRow(id); if (!campaign) throw new Error("Campaign not found.");
  const allContacts = await contactRows();
  const audience=String(campaign.audience);const savedSegment=audience.startsWith("segment:")?await env.DB.prepare("SELECT id,name,stage,tag,company,subscription,inactivity_days AS inactivityDays FROM segments WHERE id=?").bind(Number(audience.split(":")[1])).first<SegmentRule>():null;
  const contacts = allContacts.filter(contact => audienceMatch(contact, audience, savedSegment));
  if (!contacts.length) throw new Error("No subscribed contacts match this audience.");
  const segment = await resend("/segments", { method: "POST", body: JSON.stringify({ name: `CRM · ${campaign.name} · ${new Date().toISOString().slice(0,16)}` }) });
  const segmentId = String(segment.id || ""); if (!segmentId) throw new Error("Resend did not return a segment ID.");
  for (const contact of allContacts) {
    let providerId = "";
    try {
      const created = await resend("/contacts", { method: "POST", body: JSON.stringify({ email: contact.email, first_name: contact.firstName, last_name: contact.lastName, unsubscribed: !contact.subscribed }) });
      providerId = String(created.id || "");
    } catch {
      const updated = await resend(`/contacts/${encodeURIComponent(String(contact.email))}`, { method: "PATCH", body: JSON.stringify({ unsubscribed: !contact.subscribed }) });
      providerId = String(updated.id || contact.resendId || "");
    }
    if (audienceMatch(contact, audience, savedSegment)) await resend(`/contacts/${encodeURIComponent(String(contact.email))}/segments/${segmentId}`, { method: "POST" });
    await env.DB.prepare("UPDATE contacts SET resend_id=?, resend_synced_at=datetime('now') WHERE id=?").bind(providerId || null, contact.id).run();
  }
  await env.DB.prepare("UPDATE campaigns SET resend_segment_id=?, recipient_count=?, updated_at=datetime('now') WHERE id=?").bind(segmentId, contacts.length, id).run();
  return { segmentId, recipientCount: contacts.length };
}

export async function GET(request:Request) { const account=signedIn(request);if(!account)return Response.json({error:"Sign in is required."},{status:401});try { return Response.json(await readAll(account)); } catch { return Response.json({ error: "CRM data is temporarily unavailable." }, { status: 503 }); } }
export async function POST(request: Request) {
  try {
    if(!signedIn(request))return Response.json({error:"Sign in is required."},{status:401});
    const body = await request.json() as Record<string, unknown>;
    if (body.action === "createContact") {
      const firstName=clean(body.firstName), lastName=clean(body.lastName), email=clean(body.email).toLowerCase(); if (!firstName || !lastName || !email) return Response.json({error:"Name and email are required."},{status:400});
      const suppressed=await env.DB.prepare("SELECT reason FROM suppressions WHERE email=? AND removed_at IS NULL").bind(email).first<{reason:string}>();
      const result = await env.DB.prepare("INSERT INTO contacts (first_name,last_name,email,company,title,phone,stage,tags,subscribed,suppression_reason,suppressed_at,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,datetime('now'),datetime('now'))").bind(firstName,lastName,email,clean(body.company),clean(body.title),clean(body.phone),clean(body.stage,"Lead"),"[]",suppressed?0:1,suppressed?.reason||null,suppressed?new Date().toISOString():null).run(); return Response.json({id:result.meta.last_row_id},{status:201});
    }
    if (body.action === "createActivity") {
      const contactId=Number(body.contactId), note=clean(body.note), type=clean(body.type,"Note"), today=new Date().toISOString(); if (!contactId || !note) return Response.json({error:"Contact and note are required."},{status:400});
      const statements=[env.DB.prepare("INSERT INTO activities (contact_id,type,note,happened_at) VALUES (?,?,?,?)").bind(contactId,type,note,today), env.DB.prepare("UPDATE contacts SET last_contact=? WHERE id=?").bind(today.slice(0,10),contactId)];
      const next=clean(body.nextFollowUp); if(next){statements.push(env.DB.prepare("INSERT INTO tasks (contact_id,title,due_date,completed) VALUES (?,?,?,0)").bind(contactId,"Follow up after "+type.toLowerCase(),next),env.DB.prepare("UPDATE contacts SET next_follow_up=? WHERE id=?").bind(next,contactId));} await env.DB.batch(statements); return Response.json({status:"created"},{status:201});
    }
    if (body.action === "bulkImportContacts") {
      const contacts=Array.isArray(body.contacts)?body.contacts as Array<Record<string,unknown>>:[];if(!contacts.length||contacts.length>2000)return Response.json({error:"Import between 1 and 2,000 contacts at a time."},{status:400});
      const prepared=contacts.map(contact=>{const firstName=clean(contact.firstName),lastName=clean(contact.lastName),email=clean(contact.email).toLowerCase();if(!firstName||!lastName||!email.match(/^[^\s@]+@[^\s@]+\.[^\s@]+$/))throw new Error("INVALID_IMPORT_ROW");const tags=Array.isArray(contact.tags)?contact.tags.map(tag=>clean(tag)).filter(Boolean):[];return env.DB.prepare("INSERT INTO contacts (first_name,last_name,email,company,title,phone,stage,tags,subscribed,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,datetime('now'),datetime('now')) ON CONFLICT(email) DO UPDATE SET first_name=excluded.first_name,last_name=excluded.last_name,company=excluded.company,title=excluded.title,phone=excluded.phone,stage=excluded.stage,tags=excluded.tags,subscribed=excluded.subscribed,resend_synced_at=NULL,updated_at=datetime('now')").bind(firstName,lastName,email,clean(contact.company),clean(contact.title),clean(contact.phone),clean(contact.stage,"Lead"),JSON.stringify(tags),contact.subscribed===false?0:1)});
      for(let i=0;i<prepared.length;i+=100)await env.DB.batch(prepared.slice(i,i+100));await env.DB.prepare("UPDATE contacts SET subscribed=0,suppression_reason=COALESCE((SELECT reason FROM suppressions WHERE suppressions.email=contacts.email AND removed_at IS NULL),'Suppressed'),suppressed_at=COALESCE(suppressed_at,datetime('now')) WHERE email IN (SELECT email FROM suppressions WHERE removed_at IS NULL)").run();return Response.json({imported:prepared.length},{status:201});
    }
    if(body.action==="createSegment"){
      const name=clean(body.name),stage=clean(body.stage,"Any"),tag=clean(body.tag),company=clean(body.company),inactivityDays=Math.max(0,Number(body.inactivityDays)||0);if(!name)return Response.json({error:"Segment name is required."},{status:400});
      const result=await env.DB.prepare("INSERT INTO segments (name,stage,tag,company,subscription,inactivity_days,created_at,updated_at) VALUES (?,?,?,?, 'Subscribed',?,datetime('now'),datetime('now'))").bind(name,stage,tag,company,inactivityDays).run();return Response.json({id:result.meta.last_row_id},{status:201});
    }
    if(body.action==="deleteSegment"){await env.DB.prepare("DELETE FROM segments WHERE id=?").bind(Number(body.id)).run();return Response.json({status:"deleted"});}
    if(body.action==="suppressContact"){
      const email=clean(body.email).toLowerCase(),reason=clean(body.reason,"Manual unsubscribe");if(!email)return Response.json({error:"Email is required."},{status:400});
      await env.DB.batch([env.DB.prepare("INSERT INTO suppressions (email,reason,source,created_at,removed_at) VALUES (?,?,'Manual',datetime('now'),NULL) ON CONFLICT(email) DO UPDATE SET reason=excluded.reason,source='Manual',created_at=datetime('now'),removed_at=NULL").bind(email,reason),env.DB.prepare("UPDATE contacts SET subscribed=0,suppression_reason=?,suppressed_at=datetime('now'),resend_synced_at=NULL,updated_at=datetime('now') WHERE email=?").bind(reason,email)]);return Response.json({status:"suppressed"});
    }
    if(body.action==="restoreContact"){
      const email=clean(body.email).toLowerCase();await env.DB.batch([env.DB.prepare("UPDATE suppressions SET removed_at=datetime('now') WHERE email=? AND removed_at IS NULL").bind(email),env.DB.prepare("UPDATE contacts SET subscribed=1,suppression_reason=NULL,suppressed_at=NULL,resend_synced_at=NULL,updated_at=datetime('now') WHERE email=?").bind(email)]);return Response.json({status:"restored"});
    }
    if(body.action==="mergeContacts"){
      const keepId=Number(body.keepId),mergeId=Number(body.mergeId);if(!keepId||!mergeId||keepId===mergeId)return Response.json({error:"Choose two different contacts."},{status:400});
      const [keep,merge]=await Promise.all([env.DB.prepare("SELECT * FROM contacts WHERE id=?").bind(keepId).first<Record<string,unknown>>(),env.DB.prepare("SELECT * FROM contacts WHERE id=?").bind(mergeId).first<Record<string,unknown>>()]);if(!keep||!merge)return Response.json({error:"Contact not found."},{status:404});
      const tags=Array.from(new Set([...JSON.parse(String(keep.tags||"[]")),...JSON.parse(String(merge.tags||"[]"))]));await env.DB.batch([env.DB.prepare("UPDATE activities SET contact_id=? WHERE contact_id=?").bind(keepId,mergeId),env.DB.prepare("UPDATE tasks SET contact_id=? WHERE contact_id=?").bind(keepId,mergeId),env.DB.prepare("UPDATE contacts SET company=?,title=?,phone=?,stage=?,tags=?,last_contact=COALESCE(last_contact,?),next_follow_up=COALESCE(next_follow_up,?),subscribed=?,updated_at=datetime('now') WHERE id=?").bind(clean(keep.company)||clean(merge.company),clean(keep.title)||clean(merge.title),clean(keep.phone)||clean(merge.phone),clean(keep.stage,"Lead"),JSON.stringify(tags),merge.last_contact||null,merge.next_follow_up||null,Boolean(keep.subscribed)&&Boolean(merge.subscribed)?1:0,keepId),env.DB.prepare("DELETE FROM contacts WHERE id=?").bind(mergeId)]);return Response.json({status:"merged",id:keepId});
    }
    if(body.action==="duplicateCampaign"){
      const source=await campaignRow(Number(body.id));if(!source)return Response.json({error:"Campaign not found."},{status:404});const result=await env.DB.prepare("INSERT INTO campaigns (name,subject,preview_text,html,text_body,status,audience,recipient_count,created_at,updated_at) VALUES (?,?,?,?,?,'Draft',?,0,date('now'),datetime('now'))").bind(`${source.name} — Copy`,source.subject,source.previewText,source.html,source.textBody,source.audience).run();return Response.json({id:result.meta.last_row_id},{status:201});
    }
    if (body.action === "completeTask") { await env.DB.prepare("UPDATE tasks SET completed=1 WHERE id=?").bind(Number(body.id)).run(); return Response.json({status:"completed"}); }
    if (body.action === "saveCampaign") {
      const id=Number(body.id), name=clean(body.name), subject=clean(body.subject), audience=clean(body.audience,"All subscribed contacts"), previewText=clean(body.previewText), html=clean(body.html), textBody=clean(body.textBody); if(!name||!subject||!html)return Response.json({error:"Campaign name, subject, and message are required."},{status:400});
      if(id){await env.DB.prepare("UPDATE campaigns SET name=?,subject=?,preview_text=?,html=?,text_body=?,audience=?,status='Draft',resend_segment_id=NULL,resend_broadcast_id=NULL,scheduled_at=NULL,updated_at=datetime('now') WHERE id=?").bind(name,subject,previewText,html,textBody,audience,id).run();return Response.json({id});}
      const result=await env.DB.prepare("INSERT INTO campaigns (name,subject,preview_text,html,text_body,status,audience,recipient_count,created_at,updated_at) VALUES (?,?,?,?,?,'Draft',?,0,date('now'),datetime('now'))").bind(name,subject,previewText,html,textBody,audience).run(); return Response.json({id:result.meta.last_row_id},{status:201});
    }
    if (body.action === "syncCampaignAudience") return Response.json(await syncCampaign(Number(body.id)));
    if (body.action === "sendCampaignTest") {
      const campaign=await campaignRow(Number(body.id)), to=clean(body.to).toLowerCase(); if(!campaign||!to.match(/^[^\s@]+@[^\s@]+\.[^\s@]+$/))return Response.json({error:"Choose a campaign and enter a valid test address."},{status:400});
      const result=await resend("/emails",{method:"POST",body:JSON.stringify({from:fromEmail(),to:[to],subject:`[TEST] ${campaign.subject}`,html:`<div style=\"background:#eef2ff;padding:12px;font:14px sans-serif\">Test preview — this message was not sent to the campaign audience.</div>${String(campaign.html).replaceAll("{{{RESEND_UNSUBSCRIBE_URL}}}","#")}`,text:campaign.textBody||undefined,tags:[{name:"campaign_id",value:String(campaign.id)}]})}); return Response.json({id:result.id});
    }
    if (body.action === "scheduleCampaign") {
      const id=Number(body.id); let campaign=await campaignRow(id); if(!campaign)return Response.json({error:"Campaign not found."},{status:404}); if(!campaign.resendSegmentId){await syncCampaign(id);campaign=await campaignRow(id);}
      const scheduledAt=clean(body.scheduledAt); if(scheduledAt&&new Date(scheduledAt).getTime()<=Date.now()+60000)return Response.json({error:"Schedule at least two minutes in the future."},{status:400});
      const html=String(campaign?.html||"")+(!String(campaign?.html||"").includes("RESEND_UNSUBSCRIBE_URL")?'<p style="margin-top:32px;font-size:12px;color:#64748b"><a href="{{{RESEND_UNSUBSCRIBE_URL}}}">Unsubscribe</a></p>':"");
      const result=await resend("/broadcasts",{method:"POST",body:JSON.stringify({segment_id:campaign?.resendSegmentId,from:fromEmail(),name:campaign?.name,subject:campaign?.subject,html,text:campaign?.textBody||undefined,send:true,scheduled_at:scheduledAt?new Date(scheduledAt).toISOString():undefined})});
      await env.DB.prepare("UPDATE campaigns SET resend_broadcast_id=?,status=?,scheduled_at=?,sent_at=?,updated_at=datetime('now') WHERE id=?").bind(String(result.id||""),scheduledAt?"Scheduled":"Sending",scheduledAt||null,scheduledAt?null:new Date().toISOString(),id).run(); return Response.json({id:result.id,status:scheduledAt?"Scheduled":"Sending"});
    }
    return Response.json({error:"Unknown action."},{status:400});
  } catch (error) { const raw=error instanceof Error?error.message:"The CRM could not save that change."; const message=raw.includes("UNIQUE")?"A contact with that email already exists.":raw; return Response.json({error:message},{status:500}); }
}
