import { env } from "cloudflare:workers";
import { audit, sha256, type CRMUser } from "@/lib/crm-auth";
import { saveCommunicationAttachment } from "@/lib/client-documents";
import { parseMeetilyImport } from "@/lib/meetily-import";

type Row=Record<string,unknown>;
type Attendee={name:string;email:string;role:string};
type CanonicalMeeting={eventType:string;externalId:string;title:string;startsAt:string;endsAt:string|null;summary:string;transcript:string;decisions:string[];customerCommitments:string[];internalCommitments:string[];risksAndObjections:string[];nextSteps:Array<{text:string;owner:string;dueDate:string|null}>;attendees:Attendee[];dealId:number|null;companyName:string;companyDomain:string};

const EMAIL_CHUNK=50;
const clean=(value:unknown,max=12000)=>String(value??"").trim().slice(0,max);
const list=(value:unknown,max=50)=>Array.isArray(value)?value.map(item=>typeof item==="object"&&item?clean((item as Row).text||(item as Row).title||(item as Row).description,2000):clean(item,2000)).filter(Boolean).slice(0,max):clean(value).split(/\r?\n/).map(item=>item.replace(/^[-*]\s*/,"").trim()).filter(Boolean).slice(0,max);
const date=(value:unknown,fallback:string)=>{const parsed=new Date(clean(value,80));return Number.isFinite(parsed.getTime())?parsed.toISOString():fallback};
const jsonText=(value:unknown)=>typeof value==="string"?clean(value):value&&typeof value==="object"?JSON.stringify(value):"";
const one=async(sql:string,...args:(string|number|null)[])=>env.DB.prepare(sql).bind(...args).first<Row>();
const rows=async(sql:string,...args:(string|number|null)[])=>(await env.DB.prepare(sql).bind(...args).all<Row>()).results;

function normalizeAttendees(value:unknown):Attendee[]{
  if(!Array.isArray(value))return [];
  const seen=new Set<string>();const output:Attendee[]=[];
  for(const item of value){const row=typeof item==="string"?{name:item}:item&&typeof item==="object"?item as Row:{},email=clean(row.email,320).toLowerCase(),name=clean(row.name||row.displayName||row.title,240),role=clean(row.role,80)||"Attendee",key=email||name.toLowerCase();if(!key||seen.has(key))continue;seen.add(key);output.push({name,email,role})}
  return output.slice(0,100);
}

function normalize(body:Row):CanonicalMeeting{
  const meeting=body.meeting&&typeof body.meeting==="object"?body.meeting as Row:body,now=new Date().toISOString(),summary=jsonText(meeting.summary||meeting.notes||meeting.summaryMarkdown||body.summary),transcript=jsonText(meeting.transcript||meeting.transcriptText||body.transcript),parsed=parseMeetilyImport(summary,transcript,new Date(date(meeting.startedAt||meeting.startsAt||meeting.date||body.occurredAt,now)));
  const externalId=clean(meeting.id||meeting.externalId||body.externalId||body.id,240);if(!externalId)throw new Error("Meetily meeting id is required.");
  const rawNext=Array.isArray(meeting.nextSteps)?meeting.nextSteps:Array.isArray(meeting.actionItems)?meeting.actionItems:parsed.nextSteps;
  const nextSteps=(rawNext as unknown[]).map(item=>{const row=item&&typeof item==="object"?item as Row:{};return {text:typeof item==="string"?clean(item,2000):clean(row.text||row.title||row.description,2000),owner:clean(row.owner||row.assignee||meeting.owner,200)||parsed.nextStepOwner,dueDate:clean(row.dueDate||row.due,20)||parsed.nextStepDueDate||null}}).filter(item=>item.text).slice(0,50);
  const directDeal=Number(meeting.dealId||body.dealId);
  return {eventType:clean(body.event||body.type,80)||"meeting.completed",externalId,title:clean(meeting.title||meeting.subject,240)||parsed.title,startsAt:date(meeting.startedAt||meeting.startsAt||meeting.date,parsed.startsAt||now),endsAt:meeting.endedAt||meeting.endsAt?date(meeting.endedAt||meeting.endsAt,now):null,summary:clean(typeof meeting.summary==="string"?meeting.summary:parsed.summary||summary,12000),transcript:clean(transcript,750000),decisions:list(meeting.decisions).length?list(meeting.decisions):parsed.decisions,customerCommitments:list(meeting.customerCommitments).length?list(meeting.customerCommitments):parsed.customerCommitments,internalCommitments:list(meeting.internalCommitments).length?list(meeting.internalCommitments):parsed.internalCommitments,risksAndObjections:list(meeting.risksAndObjections||meeting.risks).length?list(meeting.risksAndObjections||meeting.risks):parsed.risksAndObjections,nextSteps,attendees:normalizeAttendees(meeting.attendees||meeting.participants),dealId:Number.isInteger(directDeal)&&directDeal>0?directDeal:null,companyName:clean(meeting.companyName||body.companyName,240),companyDomain:clean(meeting.companyDomain||body.companyDomain,240).toLowerCase().replace(/^https?:\/\//,"").replace(/^www\./,"").split("/")[0]};
}

async function matchedDeal(payload:CanonicalMeeting){
  if(payload.dealId&&await one("SELECT id FROM deals WHERE id=?",payload.dealId))return payload.dealId;
  const emails=payload.attendees.map(item=>item.email).filter(Boolean);
  // Each email binds twice; chunk so a statement never exceeds D1's 100 bound parameters.
  if(emails.length){const matches=new Set<number>();for(let i=0;i<emails.length;i+=EMAIL_CHUNK){const chunk=emails.slice(i,i+EMAIL_CHUNK),placeholders=chunk.map(()=>"?").join(",");for(const row of await rows(`SELECT DISTINCT d.id FROM deals d LEFT JOIN contacts primary_contact ON primary_contact.id=d.contact_id LEFT JOIN deal_stakeholders s ON s.deal_id=d.id AND s.active=1 LEFT JOIN contacts stakeholder ON stakeholder.id=s.contact_id WHERE d.status='Open' AND (lower(primary_contact.email) IN (${placeholders}) OR lower(stakeholder.email) IN (${placeholders}))`,...chunk,...chunk))matches.add(Number(row.id))}if(matches.size===1)return [...matches][0]}
  if(payload.companyDomain){const matches=await rows("SELECT DISTINCT d.id FROM deals d JOIN companies c ON c.id=d.company_id WHERE d.status='Open' AND lower(c.domain)=lower(?)",payload.companyDomain);if(matches.length===1)return Number(matches[0].id)}
  if(payload.companyName){const matches=await rows("SELECT DISTINCT d.id FROM deals d LEFT JOIN companies c ON c.id=d.company_id WHERE d.status='Open' AND (lower(c.name)=lower(?) OR lower(d.company)=lower(?))",payload.companyName,payload.companyName);if(matches.length===1)return Number(matches[0].id)}
  return null;
}

async function attendeeContacts(attendees:Attendee[]){
  const result:Array<Row&{source:Attendee}>=[];
  for(const attendee of attendees){let contact:Row|null=null;if(attendee.email)contact=await one("SELECT id,first_name||' '||last_name AS name,email FROM contacts WHERE lower(email)=lower(?)",attendee.email);if(!contact&&attendee.name)contact=await one("SELECT id,first_name||' '||last_name AS name,email FROM contacts WHERE lower(trim(first_name||' '||last_name))=lower(?)",attendee.name);if(contact)result.push({...contact,source:attendee})}
  return result;
}

export async function importMeetilyEvent(eventId:string,dealId:number,user:CRMUser){
  const event=await one("SELECT * FROM meetily_webhook_events WHERE id=?",eventId);if(!event)throw new Error("Meetily event was not found.");const payload=normalize(JSON.parse(String(event.payload_json)) as Row),deal=await one("SELECT d.*,COALESCE(d.company_id,c.id) AS resolved_company_id FROM deals d LEFT JOIN companies c ON lower(c.name)=lower(d.company) WHERE d.id=?",dealId);if(!deal)throw new Error("Choose a valid deal.");
  const existing=await one("SELECT * FROM deal_meetings WHERE source_provider='Meetily' AND external_id=?",payload.externalId),contacts=await attendeeContacts(payload.attendees),contactId=contacts[0]?.id?Number(contacts[0].id):deal.contact_id?Number(deal.contact_id):null,companyId=deal.resolved_company_id?Number(deal.resolved_company_id):null,now=new Date().toISOString(),meetingId=existing?String(existing.id):crypto.randomUUID();let transcriptDocumentId=existing?.transcript_document_id?String(existing.transcript_document_id):null;
  if(payload.transcript&&!transcriptDocumentId){const filename=`${payload.title.replace(/[^a-zA-Z0-9._ -]/g,"_").slice(0,120)||"Meetily meeting"}-transcript.txt`;transcriptDocumentId=await saveCommunicationAttachment({filename,contentType:"text/plain",bytes:new TextEncoder().encode(payload.transcript),dealId,contactId,companyId,actor:user.email,source:"Meetily"})}
  let activityId=existing?.activity_id?Number(existing.activity_id):null;
  if(activityId)await env.DB.prepare("UPDATE deal_activities SET company_id=?,contact_id=?,subject=?,body=?,owner=?,outcome='Completed',happened_at=?,source='Meetily',external_id=?,updated_at=? WHERE id=?").bind(companyId,contactId,payload.title,payload.summary||payload.title,user.email,payload.startsAt,payload.externalId,now,activityId).run();
  else{const created=await env.DB.prepare("INSERT INTO deal_activities(deal_id,company_id,contact_id,type,subject,body,owner,outcome,happened_at,source,external_id,pinned,created_at,updated_at) VALUES (?,?,?,'Meeting',?,?,?,'Completed',?,'Meetily',?,0,?,?)").bind(dealId,companyId,contactId,payload.title,payload.summary||payload.title,user.email,payload.startsAt,payload.externalId,now,now).run();activityId=Number(created.meta.last_row_id)}
  const values=[companyId,activityId,payload.title,payload.startsAt,payload.endsAt,user.email,payload.summary,JSON.stringify(payload.decisions),JSON.stringify(payload.customerCommitments),JSON.stringify(payload.internalCommitments),JSON.stringify(payload.risksAndObjections),JSON.stringify(payload.nextSteps),transcriptDocumentId,payload.externalId,now] as (string|number|null)[];
  if(existing)await env.DB.prepare("UPDATE deal_meetings SET deal_id=?,company_id=?,activity_id=?,subject=?,status='Completed',starts_at=?,ends_at=?,owner=?,summary=?,decisions_json=?,customer_commitments_json=?,internal_commitments_json=?,risks_objections_json=?,next_steps_json=?,transcript_document_id=?,external_id=?,updated_at=? WHERE id=?").bind(dealId,...values,meetingId).run();
  else await env.DB.prepare("INSERT INTO deal_meetings(id,deal_id,company_id,activity_id,subject,status,starts_at,ends_at,owner,summary,decisions_json,customer_commitments_json,internal_commitments_json,risks_objections_json,next_steps_json,transcript_document_id,source_provider,external_id,created_by,created_at,updated_at) VALUES (?,?,?,?,?,'Completed',?,?,?,?,?,?,?,?,?,?,'Meetily',?,?,?,?)").bind(meetingId,dealId,...values.slice(0,13),payload.externalId,user.email,now,now).run();
  await env.DB.prepare("DELETE FROM deal_meeting_attendees WHERE meeting_id=?").bind(meetingId).run();
  if(payload.attendees.length)await env.DB.batch(payload.attendees.map(attendee=>{const contact=contacts.find(item=>item.source.email&&item.source.email===attendee.email||!attendee.email&&item.source.name.toLowerCase()===attendee.name.toLowerCase());return env.DB.prepare("INSERT INTO deal_meeting_attendees(meeting_id,contact_id,name,email,role,created_at) VALUES (?,?,?,?,?,?)").bind(meetingId,contact?.id?Number(contact.id):null,attendee.name||clean(contact?.name,240),attendee.email||clean(contact?.email,320),attendee.role,now)}));
  await env.DB.prepare("UPDATE meetily_webhook_events SET status='Imported',deal_id=?,meeting_id=?,error='',processed_at=?,last_seen_at=? WHERE id=?").bind(dealId,meetingId,now,now,eventId).run();await audit(user,"meetily.import","deal_meeting",meetingId,existing?"Updated meeting from Meetily":"Imported meeting from Meetily",{dealId,eventId,externalId:payload.externalId,attendeeCount:payload.attendees.length,transcriptStored:Boolean(transcriptDocumentId)});return {status:"Imported",eventId,meetingId,dealId};
}

export async function ingestMeetilyWebhook(body:Row,user:CRMUser){
  const payload=normalize(body),payloadJson=JSON.stringify(body);if(payloadJson.length>1_500_000)throw new Error("Meetily payload is too large.");const payloadHash=await sha256(payloadJson),existing=await one("SELECT * FROM meetily_webhook_events WHERE external_id=?",payload.externalId),now=new Date().toISOString();
  if(existing&&String(existing.payload_hash)===payloadHash){await env.DB.prepare("UPDATE meetily_webhook_events SET duplicate_count=duplicate_count+1,last_seen_at=? WHERE id=?").bind(now,String(existing.id)).run();return {status:String(existing.status),eventId:String(existing.id),meetingId:existing.meeting_id||null,dealId:existing.deal_id||null,duplicate:true}}
  const eventId=existing?String(existing.id):crypto.randomUUID();if(existing)await env.DB.prepare("UPDATE meetily_webhook_events SET event_type=?,payload_json=?,payload_hash=?,subject=?,occurred_at=?,status='Received',error='',last_seen_at=? WHERE id=?").bind(payload.eventType,payloadJson,payloadHash,payload.title,payload.startsAt,now,eventId).run();else await env.DB.prepare("INSERT INTO meetily_webhook_events(id,external_id,event_type,payload_json,payload_hash,subject,occurred_at,status,received_at,last_seen_at) VALUES (?,?,?,?,?,?,?,'Received',?,?)").bind(eventId,payload.externalId,payload.eventType,payloadJson,payloadHash,payload.title,payload.startsAt,now,now).run();
  const dealId=await matchedDeal(payload);if(!dealId){await env.DB.prepare("UPDATE meetily_webhook_events SET status='Needs association',error='No single deal match was found.' WHERE id=?").bind(eventId).run();return {status:"Needs association",eventId,meetingId:null,dealId:null,duplicate:false}}
  try{return {...await importMeetilyEvent(eventId,dealId,user),duplicate:false}}catch(error){const message=error instanceof Error?error.message:"Meetily import failed.";await env.DB.prepare("UPDATE meetily_webhook_events SET status='Failed',error=? WHERE id=?").bind(message,eventId).run();throw error}
}
