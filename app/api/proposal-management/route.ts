import { env } from "cloudflare:workers";
import { audit, can, crmUser } from "@/lib/crm-auth";
import { fromEmail, resend, sendingIdentity } from "@/lib/resend";
import { withoutShareToken } from "@/lib/proposals";

type Row=Record<string,unknown>;
const clean=(value:unknown,max=12000)=>String(value??"").trim().slice(0,max);
const id=(value:unknown)=>{const result=Number(value);if(!Number.isInteger(result)||result<1)throw new Error("Choose a valid proposal.");return result};
const day=(value:unknown)=>{const result=clean(value,20);return /^\d{4}-\d{2}-\d{2}$/.test(result)?result:null};
const number=(value:unknown,min:number,max:number)=>Math.max(min,Math.min(max,Math.round(Number(value)||0)));
const email=(value:unknown)=>clean(value,320).toLowerCase();
const rows=async(sql:string,...args:(string|number|null)[])=>(await env.DB.prepare(sql).bind(...args).all()).results as Row[];
const token=()=>{const bytes=crypto.getRandomValues(new Uint8Array(24));let value="";for(const byte of bytes)value+=String.fromCharCode(byte);return btoa(value).replaceAll("+","-").replaceAll("/","_").replaceAll("=","")};
function expires(value:unknown,fallback:string|null){const candidate=day(value)||fallback;if(candidate)return `${candidate}T23:59:59.999Z`;return new Date(Date.now()+30*86400000).toISOString()}

async function proposal(proposalId:number){return env.DB.prepare("SELECT p.*,d.name AS deal_name,d.company,d.company_id AS company_id,d.contact_id AS contact_id,c.first_name||' '||c.last_name AS contact_name,c.email AS contact_email,a.signer_name AS signerName,a.signer_email AS signerEmail,a.signer_title AS signerTitle,a.accepted_at AS signatureAcceptedAt FROM deal_proposals p JOIN deals d ON d.id=p.deal_id LEFT JOIN contacts c ON c.id=d.contact_id LEFT JOIN proposal_acceptances a ON a.proposal_id=p.id WHERE p.id=?").bind(proposalId).first<Row>()}
function commercial(input:Row,record:Row){return {contractStartDate:day(input.contractStartDate)??(record.contract_start_date?String(record.contract_start_date):null),contractEndDate:day(input.contractEndDate)??(record.contract_end_date?String(record.contract_end_date):null),renewalTermMonths:number(input.renewalTermMonths??record.renewal_term_months,0,120)||null,renewalNoticeDays:number(input.renewalNoticeDays??record.renewal_notice_days,0,730)||null,autoRenew:input.autoRenew===true||input.autoRenew==="true"||input.autoRenew===1,contractTerms:clean(input.contractTerms??record.contract_terms,24000)}}
async function saveCommercial(record:Row,input:Row){
 if(record.accepted_at)throw new Error("Create a revised proposal instead of changing an accepted agreement.");const values=commercial(input,record),now=new Date().toISOString();
 if(values.contractStartDate&&values.contractEndDate&&values.contractEndDate<values.contractStartDate)throw new Error("Contract end date must be after the start date.");
 await env.DB.prepare("UPDATE deal_proposals SET contract_start_date=?,contract_end_date=?,renewal_term_months=?,renewal_notice_days=?,auto_renew=?,contract_terms=?,updated_at=? WHERE id=?").bind(values.contractStartDate,values.contractEndDate,values.renewalTermMonths,values.renewalNoticeDays,values.autoRenew?1:0,values.contractTerms,now,record.id).run();return values;
}

export async function GET(request:Request){
 const user=await crmUser(request);if(!user)return Response.json({error:"Sign in is required."},{status:401});if(!can(user,"records.view"))return Response.json({error:"View access is required."},{status:403});
 try{const [proposals,brand]=await Promise.all([
  rows("SELECT p.*,d.name AS dealName,d.company,d.contact_id AS contactId,c.first_name||' '||c.last_name AS contactName,c.email AS contactEmail,a.signer_name AS signerName,a.signer_email AS signerEmail,a.signer_title AS signerTitle,a.accepted_at AS signatureAcceptedAt,(SELECT count(*) FROM proposal_share_events e WHERE e.proposal_id=p.id AND e.type='Opened') AS openCount FROM deal_proposals p JOIN deals d ON d.id=p.deal_id LEFT JOIN contacts c ON c.id=d.contact_id LEFT JOIN proposal_acceptances a ON a.proposal_id=p.id ORDER BY p.updated_at DESC LIMIT 200"),
  env.DB.prepare("SELECT business_name AS businessName,logo_url AS logoUrl,physical_address AS physicalAddress,from_name AS fromName,from_email AS fromEmail FROM brand_settings WHERE id=1").first<Row>(),
 ]);const origin=new URL(request.url).origin;const canShare=can(user,"records.edit");return Response.json({account:{email:user.email},proposals:proposals.map(item=>({...withoutShareToken(item),shareUrl:canShare&&item.share_token?`${origin}/proposal/${item.share_token}`:null})),brand:brand||{businessName:"ClientRecord",logoUrl:"",physicalAddress:"",fromName:"",fromEmail:""}});
 }catch(error){console.error(error);return Response.json({error:"Commercial proposals could not load."},{status:503});}
}

export async function POST(request:Request){
 const user=await crmUser(request);if(!user)return Response.json({error:"Sign in is required."},{status:401});if(!can(user,"records.edit"))return Response.json({error:"Edit access is required."},{status:403});
 try{const body=await request.json() as Row,action=clean(body.action,60),proposalId=id(body.proposalId),record=await proposal(proposalId);if(!record)throw new Error("Proposal not found.");const now=new Date().toISOString(),origin=new URL(request.url).origin;
  if(action==="saveTerms"||action==="prepareLink"||action==="sendLink")await saveCommercial(record,body);
  let current=await proposal(proposalId);if(!current)throw new Error("Proposal not found.");
  if(action==="saveTerms"){await audit(user,"proposal.terms","deal_proposal",proposalId,"Updated contract dates and renewal terms",commercial(body,current));return Response.json({ok:true});}
  if(action==="prepareLink"||action==="sendLink"){
   const regenerate=body.regenerate===true,shareToken=regenerate||!current.share_token?token():String(current.share_token),shareExpiresAt=expires(body.shareExpiresAt,current.valid_until?String(current.valid_until):null);await env.DB.prepare("UPDATE deal_proposals SET share_token=?,share_expires_at=?,contract_status=CASE WHEN contract_status='Draft' THEN 'Ready for signature' ELSE contract_status END,updated_at=? WHERE id=?").bind(shareToken,shareExpiresAt,now,proposalId).run();current=await proposal(proposalId);
   const shareUrl=`${origin}/proposal/${shareToken}`;
   if(action==="prepareLink"){await audit(user,"proposal.link.prepare","deal_proposal",proposalId,"Prepared branded proposal link",{shareExpiresAt});return Response.json({ok:true,shareUrl});}
   const recipient=email(body.recipient||current?.sent_to||current?.contact_email);if(!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(recipient))throw new Error("Enter a valid customer email.");const identity=await sendingIdentity(),subject=clean(body.subject,500)||`${current?.title||"Proposal"} from ${identity.businessName||"ClientRecord"}`,note=clean(body.message,5000)||"Your proposal is ready to review. You can view the terms, accept, and sign securely using the link below.";
   const sent=await resend("/emails",{method:"POST",body:JSON.stringify({from:fromEmail(identity),to:[recipient],reply_to:identity.replyToEmail||undefined,subject,html:`<div style="font:16px Arial,sans-serif;line-height:1.6;color:#172033"><p>${note.replace(/[&<>]/g,char=>({"&":"&amp;","<":"&lt;",">":"&gt;"}[char]||char)).replaceAll("\n","<br/>")}</p><p><a href="${shareUrl}" style="display:inline-block;background:#3156c9;color:white;padding:12px 18px;border-radius:7px;text-decoration:none;font-weight:700">Review and sign proposal</a></p><p style="font-size:13px;color:#64748b">This link expires ${new Date(shareExpiresAt).toLocaleDateString()}.</p></div>`,text:`${note}\n\nReview and sign: ${shareUrl}`})}) as Row;
   await env.DB.batch([env.DB.prepare("UPDATE deal_proposals SET status='Sent',sent_to=?,sent_at=COALESCE(sent_at,?),contract_status='Sent for signature',updated_at=? WHERE id=?").bind(recipient,now,now,proposalId),env.DB.prepare("INSERT INTO proposal_share_events(proposal_id,type,recipient,metadata_json,occurred_at) VALUES (?,'Sent',?,?,?)").bind(proposalId,recipient,JSON.stringify({provider:"resend",emailId:sent.id||null}),now),env.DB.prepare("INSERT INTO delivery_logs(provider,kind,status,recipient,subject,external_id,error,context,created_at) VALUES ('resend','proposal','Sent',?,?,?,'',?,datetime('now'))").bind(recipient,subject,clean(sent.id,240),JSON.stringify({proposalId,shareUrl}))]);await audit(user,"proposal.link.send","deal_proposal",proposalId,"Sent branded proposal for customer acceptance",{recipient,shareExpiresAt,contractStatus:"Sent for signature"});return Response.json({ok:true,shareUrl});
  }
  if(action==="revokeLink"){if(current.accepted_at)throw new Error("An accepted agreement cannot be revoked.");await env.DB.prepare("UPDATE deal_proposals SET share_expires_at=?,contract_status='Link revoked',updated_at=? WHERE id=?").bind(now,now,proposalId).run();await env.DB.prepare("INSERT INTO proposal_share_events(proposal_id,type,recipient,metadata_json,occurred_at) VALUES (?,'Revoked','',?,?)").bind(proposalId,"{}",now).run();await audit(user,"proposal.link.revoke","deal_proposal",proposalId,"Revoked proposal link",{});return Response.json({ok:true});}
  throw new Error("Unknown proposal action.");
 }catch(error){return Response.json({error:error instanceof Error?error.message:"The proposal could not be updated."},{status:400});}
}
