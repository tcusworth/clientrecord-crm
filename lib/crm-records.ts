// Server-side contact/company reads for the CRM: paged + filtered lists, small searches, record detail and COUNT-based
// summaries, so the browser never has to download every contact or company. All SQL is parameterized; user text only
// ever reaches SQL as a bound LIKE pattern (escaped) and sort keys come from an allowlist.
type Bind=string|number|null;
type Row=Record<string,unknown>;
export type ContactFilter={q:string;stage:string;subscription:string;tag:string;view:string;companyId:number};
export type ContactQuery=ContactFilter&{sort:string;offset:number;limit:number};
export type CompanyQuery={q:string;temperature:string;offset:number;limit:number};
export const MAX_PAGE_SIZE=200,DEFAULT_PAGE_SIZE=50,MAX_SEARCH_RESULTS=20;
const QUIET_DAYS=30;
const CONTACT_SORTS:Record<string,string>={
  name:"c.last_name COLLATE NOCASE,c.first_name COLLATE NOCASE,c.id",
  recent:"c.last_contact DESC,c.id DESC",
  followup:"c.next_follow_up IS NULL,c.next_follow_up,c.id",
  newest:"c.id DESC",
};
const CONTACT_LIST_COLUMNS="c.id,c.first_name AS firstName,c.last_name AS lastName,c.email,c.company,c.title,c.phone,c.location,c.stage,c.tags,c.last_contact AS lastContact,c.next_follow_up AS nextFollowUp,c.subscribed,c.suppression_reason AS suppressionReason";
const CONTACT_DETAIL_COLUMNS=`${CONTACT_LIST_COLUMNS},c.notes,c.lead_source AS leadSource,c.suppressed_at AS suppressedAt,c.created_at AS createdAt,c.updated_at AS updatedAt`;
const text=(value:unknown,max=200)=>(typeof value==="string"?value:value==null?"":String(value)).trim().slice(0,max);
const int=(value:unknown,fallback:number,min:number,max:number)=>{const n=Math.trunc(Number(value));return Number.isFinite(n)&&String(value??"").trim()!==""?Math.min(max,Math.max(min,n)):fallback};
/** `%text%` for `LIKE ? ESCAPE '\'`, with the LIKE wildcards in the user's text escaped. */
export function likeContains(value:string){return `%${value.replace(/[\\%_]/g,match=>`\\${match}`)}%`}
const LIKE="LIKE ? ESCAPE '\\'";
type Params={get:(key:string)=>unknown};
const params=(source:URLSearchParams|Row):Params=>source instanceof URLSearchParams?{get:key=>source.get(key)}:{get:key=>source[key]};
export function contactFilter(source:URLSearchParams|Row):ContactFilter{const p=params(source);return {q:text(p.get("q")),stage:text(p.get("stage"),40),subscription:text(p.get("subscription"),20),tag:text(p.get("tag"),100),view:text(p.get("view"),40),companyId:int(p.get("companyId"),0,0,Number.MAX_SAFE_INTEGER)}}
export function contactQuery(source:URLSearchParams|Row):ContactQuery{const p=params(source),sort=text(p.get("sort"),20);return {...contactFilter(source),sort:Object.hasOwn(CONTACT_SORTS,sort)?sort:"name",offset:int(p.get("offset"),0,0,1_000_000),limit:int(p.get("limit"),DEFAULT_PAGE_SIZE,1,MAX_PAGE_SIZE)}}
export const quietCutoff=(now=Date.now())=>new Date(now-QUIET_DAYS*86400000).toISOString().slice(0,10);
/** WHERE clause (alias `c`) for the contact list, bulk actions and exports; same semantics the client used to apply in memory. */
export function contactWhere(filter:ContactFilter){
  const parts:string[]=[],binds:Bind[]=[];
  if(filter.q){const like=likeContains(filter.q);parts.push(`(c.first_name||' '||c.last_name ${LIKE} OR c.email ${LIKE} OR c.company ${LIKE} OR c.location ${LIKE} OR c.tags ${LIKE})`);binds.push(like,like,like,like,like)}
  if(filter.stage&&filter.stage!=="Any"){parts.push("c.stage=?");binds.push(filter.stage)}
  if(filter.subscription==="Subscribed")parts.push("c.subscribed=1");else if(filter.subscription==="Unsubscribed")parts.push("c.subscribed=0");
  if(filter.tag){parts.push(`EXISTS(SELECT 1 FROM json_each(CASE WHEN json_valid(c.tags) THEN c.tags ELSE '[]' END) t WHERE t.value ${LIKE})`);binds.push(likeContains(filter.tag))}
  if(filter.view==="Customers")parts.push("c.stage='Customer'");
  else if(filter.view==="Needs follow-up")parts.push("c.next_follow_up IS NOT NULL AND c.next_follow_up<>''");
  else if(filter.view==="Quiet 30+ days"){parts.push("c.last_contact IS NOT NULL AND c.last_contact<>'' AND c.last_contact<?");binds.push(quietCutoff())}
  if(filter.companyId){parts.push("(lower(trim(c.company))=(SELECT lower(trim(name)) FROM companies WHERE id=?) OR c.id IN (SELECT contact_id FROM account_stakeholders WHERE company_id=?))");binds.push(filter.companyId,filter.companyId)}
  return {sql:parts.length?`WHERE ${parts.join(" AND ")}`:"",binds};
}
function tags(value:unknown){try{const parsed=JSON.parse(String(value||"[]"));return Array.isArray(parsed)?parsed.map(String):[]}catch{return []}}
export const contactRow=(row:Row)=>({...row,tags:tags(row.tags),subscribed:Boolean(row.subscribed)});
export async function listContacts(db:D1Database,query:ContactQuery){
  const where=contactWhere(query);
  const [rows,total]=await db.batch([db.prepare(`SELECT ${CONTACT_LIST_COLUMNS} FROM contacts c ${where.sql} ORDER BY ${CONTACT_SORTS[query.sort]} LIMIT ? OFFSET ?`).bind(...where.binds,query.limit,query.offset),db.prepare(`SELECT count(*) AS total FROM contacts c ${where.sql}`).bind(...where.binds)]);
  return {rows:(rows.results as Row[]).map(contactRow),total:Number((total.results as Row[])[0]?.total||0),offset:query.offset,limit:query.limit,sort:query.sort};
}
/** Contact ids matching a list filter (for "apply to all matching" bulk actions), capped. */
export async function contactIdsMatching(db:D1Database,filter:ContactFilter,cap:number){const where=contactWhere(filter);return ((await db.prepare(`SELECT c.id FROM contacts c ${where.sql} ORDER BY c.id LIMIT ?`).bind(...where.binds,cap).all()).results as Row[]).map(row=>Number(row.id))}
/** Dashboard / campaign counts computed in SQL (one scan) instead of filtering every contact in the browser. */
export async function contactSummary(db:D1Database){
  const row=await db.prepare("SELECT count(*) AS total,COALESCE(sum(stage='Customer'),0) AS customers,COALESCE(sum(subscribed=1),0) AS subscribed,COALESCE(sum(subscribed=1 AND stage='Customer'),0) AS subscribedCustomers,COALESCE(sum(subscribed=1 AND stage IN ('Prospect','Opportunity')),0) AS subscribedProspects,COALESCE(sum(last_contact IS NOT NULL AND last_contact<>'' AND last_contact<?),0) AS quiet,COALESCE(sum(next_follow_up IS NOT NULL AND next_follow_up<>''),0) AS needsFollowUp FROM contacts").bind(quietCutoff()).first<Row>();
  return Object.fromEntries(["total","customers","subscribed","subscribedCustomers","subscribedProspects","quiet","needsFollowUp"].map(key=>[key,Number(row?.[key]||0)])) as Record<"total"|"customers"|"subscribed"|"subscribedCustomers"|"subscribedProspects"|"quiet"|"needsFollowUp",number>;
}
export type SegmentRule={id:number;name:string;stage:string;tag:string;company:string;location:string;subscription:string;inactivityDays:number};
/** SQL twin of the segment audience rules (subscribed, stage, exact tag, company/location contains, no contact for N days). */
export function segmentWhere(segment:SegmentRule){
  const parts=["c.subscribed=1"],binds:Bind[]=[];
  if(segment.stage&&segment.stage!=="Any"){parts.push("c.stage=?");binds.push(segment.stage)}
  if(segment.tag){parts.push("EXISTS(SELECT 1 FROM json_each(CASE WHEN json_valid(c.tags) THEN c.tags ELSE '[]' END) t WHERE lower(t.value)=lower(?))");binds.push(segment.tag)}
  if(segment.company){parts.push(`c.company ${LIKE}`);binds.push(likeContains(segment.company))}
  if(segment.location){parts.push(`c.location ${LIKE}`);binds.push(likeContains(segment.location))}
  const days=Math.max(0,Number(segment.inactivityDays)||0);if(days>0){parts.push("(c.last_contact IS NULL OR c.last_contact='' OR julianday(c.last_contact)<=julianday('now',?))");binds.push(`-${days} days`)}
  return {sql:`WHERE ${parts.join(" AND ")}`,binds};
}
export async function segmentCounts(db:D1Database,segments:SegmentRule[]){if(!segments.length)return [];const results=await db.batch(segments.map(segment=>{const where=segmentWhere(segment);return db.prepare(`SELECT count(*) AS total FROM contacts c ${where.sql}`).bind(...where.binds)}));return results.map(result=>Number((result.results as Row[])[0]?.total||0))}
/** Contact detail: the full record plus its own activity, campaign events, custom field values and likely duplicates. */
export async function contactDetail(db:D1Database,id:number){
  const contact=await db.prepare(`SELECT ${CONTACT_DETAIL_COLUMNS} FROM contacts c WHERE c.id=?`).bind(id).first<Row>();
  if(!contact)return null;
  const [activities,events,values,duplicates]=await db.batch([
    db.prepare("SELECT a.id,a.contact_id AS contactId,a.type,a.note,a.happened_at AS happenedAt FROM activities a WHERE a.contact_id=? ORDER BY a.happened_at DESC LIMIT 100").bind(id),
    db.prepare("SELECT e.id,e.campaign_id AS campaignId,e.type,e.recipient,e.occurred_at AS occurredAt,m.name AS campaignName,m.subject FROM campaign_events e JOIN campaigns m ON m.id=e.campaign_id WHERE lower(e.recipient)=lower(?) ORDER BY e.occurred_at DESC LIMIT 100").bind(String(contact.email||"")),
    db.prepare("SELECT definition_id AS definitionId,entity_type AS entityType,entity_id AS entityId,value FROM custom_field_values WHERE entity_type='contact' AND entity_id=?").bind(id),
    db.prepare("SELECT c.id,c.first_name AS firstName,c.last_name AS lastName,c.email,c.company FROM contacts c WHERE c.id<>? AND c.last_name=? COLLATE NOCASE AND c.first_name=? COLLATE NOCASE AND (c.company=? OR c.company='' OR ?='') ORDER BY c.id LIMIT 20").bind(id,String(contact.lastName||""),String(contact.firstName||""),String(contact.company||""),String(contact.company||"")),
  ]);
  return {contact:contactRow(contact),activities:activities.results,campaignEvents:events.results,customFieldValues:values.results,duplicates:duplicates.results};
}
/** Small typeahead result sets for pickers and the command bar. `ids` resolves labels for already-selected values. */
export async function searchRecords(db:D1Database,source:URLSearchParams|Row){
  const p=params(source),q=text(p.get("q")),limit=int(p.get("limit"),8,1,MAX_SEARCH_RESULTS),types=text(p.get("types")||"contact,company,deal",60).split(",").map(value=>value.trim()),ids=text(p.get("ids"),400).split(",").map(Number).filter(id=>Number.isInteger(id)&&id>0).slice(0,MAX_SEARCH_RESULTS),companyId=int(p.get("companyId"),0,0,Number.MAX_SAFE_INTEGER),like=likeContains(q);
  const byIds=(column:string)=>ids.length?{sql:`${column} IN (${ids.map(()=>"?").join(",")})`,binds:ids as Bind[]}:null;
  const statements:Array<[string,D1PreparedStatement]>=[];
  if(types.includes("contact")){const idFilter=byIds("c.id"),scope=companyId?contactWhere({q:"",stage:"",subscription:"",tag:"",view:"",companyId}):{sql:"",binds:[]},conditions=[idFilter?idFilter.sql:q?`(c.first_name||' '||c.last_name ${LIKE} OR c.email ${LIKE} OR c.company ${LIKE} OR c.title ${LIKE})`:"1=1",scope.sql.replace(/^WHERE /,"")].filter(Boolean);statements.push(["contacts",db.prepare(`SELECT c.id,c.first_name AS firstName,c.last_name AS lastName,c.email,c.company,c.title,c.stage FROM contacts c WHERE ${conditions.join(" AND ")} ORDER BY c.last_name COLLATE NOCASE,c.first_name COLLATE NOCASE,c.id LIMIT ?`).bind(...(idFilter?idFilter.binds:q?[like,like,like,like]:[]),...scope.binds,limit)])}
  if(types.includes("company")){const idFilter=byIds("id");statements.push(["companies",db.prepare(`SELECT id,name,stage,domain,owner FROM companies WHERE ${idFilter?idFilter.sql:q?`name ${LIKE} OR domain ${LIKE}`:"1=1"} ORDER BY name LIMIT ?`).bind(...(idFilter?idFilter.binds:q?[like,like]:[]),limit)])}
  if(types.includes("deal")){const idFilter=byIds("id");statements.push(["deals",db.prepare(`SELECT id,name,company,stage,owner,status FROM deals WHERE ${idFilter?idFilter.sql:q?`name ${LIKE} OR company ${LIKE}`:"1=1"} ORDER BY updated_at DESC LIMIT ?`).bind(...(idFilter?idFilter.binds:q?[like,like]:[]),limit)])}
  const results=statements.length?await db.batch(statements.map(([,statement])=>statement)):[];
  return Object.fromEntries([["contacts",[]],["companies",[]],["deals",[]],...statements.map(([key],index)=>[key,results[index].results])]) as {contacts:Row[];companies:Row[];deals:Row[]};
}
/** Records whose full name/email (contacts) or name (companies, deals) appear inside free text, for the command bar parser. */
export async function recordMentions(db:D1Database,value:unknown){
  const input=text(value,500).toLowerCase();if(!input)return {contact:null,company:null,deal:null};
  const [contact,company,deal]=await db.batch([
    db.prepare("SELECT id,first_name AS firstName,last_name AS lastName,email,company,title FROM contacts WHERE (length(trim(first_name||' '||last_name))>1 AND instr(?,lower(first_name||' '||last_name))>0) OR (email<>'' AND instr(?,lower(email))>0) ORDER BY last_name COLLATE NOCASE,first_name COLLATE NOCASE,id LIMIT 1").bind(input,input),
    db.prepare("SELECT id,name,stage FROM companies WHERE length(trim(name))>1 AND instr(?,lower(name))>0 ORDER BY name LIMIT 1").bind(input),
    db.prepare("SELECT id,name,company,stage,owner FROM deals WHERE length(trim(name))>1 AND instr(?,lower(name))>0 ORDER BY updated_at DESC LIMIT 1").bind(input),
  ]);
  return {contact:(contact.results as Row[])[0]||null,company:(company.results as Row[])[0]||null,deal:(deal.results as Row[])[0]||null};
}
export function companyQuery(source:URLSearchParams|Row):CompanyQuery{const p=params(source),temperature=text(p.get("temperature"),20);return {q:text(p.get("q")),temperature:["Cold","Lukewarm","Hot"].includes(temperature)?temperature:"",offset:int(p.get("offset"),0,0,1_000_000),limit:int(p.get("limit"),DEFAULT_PAGE_SIZE,1,MAX_PAGE_SIZE)}}
const PEOPLE_COUNT="(SELECT count(*) FROM contacts c WHERE lower(trim(c.company))=lower(trim(co.name)))+(SELECT count(*) FROM account_stakeholders s JOIN contacts c ON c.id=s.contact_id WHERE s.company_id=co.id AND lower(trim(c.company))<>lower(trim(co.name)))";
/** Paged company list with per-row stakeholder counts and per-temperature totals for the filter chips. */
export async function listCompanies(db:D1Database,query:CompanyQuery){
  const parts:string[]=[],binds:Bind[]=[];
  if(query.q){const like=likeContains(query.q);parts.push(`(co.name ${LIKE} OR co.industry ${LIKE} OR co.territory ${LIKE} OR co.owner ${LIKE} OR co.tags ${LIKE})`);binds.push(like,like,like,like,like)}
  const searchSql=parts.length?`WHERE ${parts.join(" AND ")}`:"",filterSql=query.temperature?`${searchSql?`${searchSql} AND`:"WHERE"} co.temperature=?`:searchSql,filterBinds=query.temperature?[...binds,query.temperature]:binds;
  const [rows,total,temperatures]=await db.batch([
    db.prepare(`SELECT co.id,co.name,co.domain,co.industry,co.stage,co.temperature,co.fit_score,co.intent_score,co.owner,co.territory,co.tier,${PEOPLE_COUNT} AS people_count FROM companies co ${filterSql} ORDER BY co.name LIMIT ? OFFSET ?`).bind(...filterBinds,query.limit,query.offset),
    db.prepare(`SELECT count(*) AS total FROM companies co ${filterSql}`).bind(...filterBinds),
    db.prepare(`SELECT co.temperature,count(*) AS total FROM companies co ${searchSql} GROUP BY co.temperature`).bind(...binds),
  ]);
  return {rows:rows.results,total:Number((total.results as Row[])[0]?.total||0),temperatures:Object.fromEntries((temperatures.results as Row[]).map(row=>[String(row.temperature||"Cold"),Number(row.total||0)])),offset:query.offset,limit:query.limit};
}
/** Company detail by id or exact name: the full row plus the people linked by company name or stakeholder role. */
export async function companyDetail(db:D1Database,source:URLSearchParams|Row){
  const p=params(source),id=int(p.get("id"),0,0,Number.MAX_SAFE_INTEGER),name=text(p.get("name"),240);
  const company=id?await db.prepare("SELECT * FROM companies WHERE id=?").bind(id).first<Row>():name?await db.prepare("SELECT * FROM companies WHERE name=?").bind(name).first<Row>():null;
  const companyName=String(company?.name||name);if(!companyName)return null;
  const people=(await db.prepare("SELECT c.id,c.first_name||' '||c.last_name AS name,c.email,c.company,c.title FROM contacts c WHERE lower(trim(c.company))=lower(trim(?)) OR c.id IN (SELECT contact_id FROM account_stakeholders WHERE company_id=?) ORDER BY c.first_name COLLATE NOCASE,c.last_name COLLATE NOCASE LIMIT 500").bind(companyName,Number(company?.id||0)).all()).results;
  return {company:company||null,people};
}
/**
 * Idempotently creates a company row for each company name used by the given contacts that has no case-insensitive
 * match yet. Runs on the write paths that set contacts.company (create/update/import/capture), never on reads.
 */
export function reconcileCompaniesStatement(db:D1Database,contactIds?:number[]){
  const scope=contactIds?`AND c.id IN (${contactIds.map(()=>"?").join(",")||"NULL"})`:"";
  return db.prepare(`INSERT INTO companies(name,updated_at)
    SELECT MIN(trim(c.company)),datetime('now') FROM contacts c
    WHERE trim(c.company)<>'' ${scope} AND NOT EXISTS(SELECT 1 FROM companies existing WHERE lower(existing.name)=lower(trim(c.company)))
    GROUP BY lower(trim(c.company))`).bind(...(contactIds||[]));
}
/** Same reconciliation keyed by raw company names (for writes that know the name but not the contact ids). */
export function reconcileCompanyNamesStatements(db:D1Database,names:unknown[]){
  const unique=[...new Map(names.map(name=>text(name,240)).filter(Boolean).map(name=>[name.toLowerCase(),name])).values()];
  return unique.map(name=>db.prepare("INSERT INTO companies(name,updated_at) SELECT ?,datetime('now') WHERE NOT EXISTS(SELECT 1 FROM companies WHERE lower(name)=lower(?))").bind(name,name));
}
export async function reconcileCompanyNames(db:D1Database,names:unknown[]){const statements=reconcileCompanyNamesStatements(db,names);for(let i=0;i<statements.length;i+=100)await db.batch(statements.slice(i,i+100))}
