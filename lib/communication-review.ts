import { env } from "cloudflare:workers";

type Row=Record<string,unknown>;
const clean=(value:unknown,max=1000)=>String(value??"").trim().slice(0,max);
const domain=(email:string)=>email.includes("@")?email.split("@").pop()!.toLowerCase():"";

export async function queueCommunicationReview(input:{source:string;sourceId:string;kind:"Unknown contact"|"Ambiguous company"|"Ambiguous deal";senderEmail?:string;senderName?:string;subject?:string;evidence?:Row;suggestedContact?:Row;companyCandidates?:Row[];dealCandidates?:Row[];contactId?:number|null;companyId?:number|null;confidence?:number}){
 const now=new Date().toISOString(),id=crypto.randomUUID(),senderEmail=clean(input.senderEmail,320).toLowerCase();
 await env.DB.prepare("INSERT INTO communication_review_items(id,source,source_id,kind,status,sender_email,sender_name,subject,evidence_json,suggested_contact_json,company_candidates_json,deal_candidates_json,contact_id,company_id,confidence,created_at) VALUES (?,?,?,?,'Pending',?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(source,source_id,kind) DO UPDATE SET evidence_json=excluded.evidence_json,suggested_contact_json=excluded.suggested_contact_json,company_candidates_json=excluded.company_candidates_json,deal_candidates_json=excluded.deal_candidates_json,confidence=excluded.confidence")
  .bind(id,clean(input.source,80),clean(input.sourceId,240),input.kind,senderEmail,clean(input.senderName,240),clean(input.subject,500),JSON.stringify(input.evidence||{}),JSON.stringify(input.suggestedContact||{email:senderEmail,companyDomain:domain(senderEmail)}),JSON.stringify(input.companyCandidates||[]),JSON.stringify(input.dealCandidates||[]),input.contactId||null,input.companyId||null,Math.max(0,Math.min(100,input.confidence||0)),now).run();
}

export async function communicationCandidates(senderEmail:string,contactId?:number|null,companyId?:number|null){
 const senderDomain=domain(senderEmail),companies=senderDomain?(await env.DB.prepare("SELECT id,name,domain,owner FROM companies WHERE lower(domain)=? OR lower(website) LIKE ? ORDER BY updated_at DESC LIMIT 8").bind(senderDomain,`%${senderDomain}%`).all<Row>()).results:[],resolvedCompanyId=companyId||Number(companies.length===1?companies[0].id:0)||null;
 const deals=(await env.DB.prepare("SELECT id,name,company,company_id AS companyId,contact_id AS contactId,stage,owner,value FROM deals WHERE status='Open' AND ((? IS NOT NULL AND contact_id=?) OR (? IS NOT NULL AND company_id=?)) ORDER BY updated_at DESC LIMIT 12").bind(contactId||null,contactId||null,resolvedCompanyId,resolvedCompanyId).all<Row>()).results;
 return {companies,deals,resolvedCompanyId};
}
