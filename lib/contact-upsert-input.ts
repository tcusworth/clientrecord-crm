export type UpsertSource="contact_form"|"epc_inquiry"|"report_download"|"decoder"|"insights_signup";
export const SOURCE_LABELS:Record<UpsertSource,string>={contact_form:"Contact form",epc_inquiry:"EPC inquiry",report_download:"Report download",decoder:"Decoder",insights_signup:"Insights signup"};
export type UpsertInput={email:string;firstName:string;lastName:string;jobTitle:string;company:string;note:{title:string;body:string}|null;source:UpsertSource;reportName:string;consent:boolean|null;consentText:string;referrer:string;utm:{source:string;medium:string;campaign:string;term:string;content:string};lists:string[];submissionId:string};
const TRUE=new Set(["true","yes","on","1"]),FALSE=new Set(["false","no","off","0"]);
export function parseUpsertInput(body:unknown):{ok:true;value:UpsertInput}|{ok:false;fields:Record<string,string>}{
  const fields:Record<string,string>={};
  if(!body||typeof body!=="object"||Array.isArray(body))return {ok:false,fields:{body:"Send a JSON object."}};
  const b=body as Record<string,unknown>;
  const text=(key:string,value:unknown,max:number)=>{if(value==null)return "";if(typeof value!=="string"&&typeof value!=="number"){fields[key]="Must be text.";return ""}const v=String(value).trim();if(v.length>max)fields[key]=`At most ${max} characters.`;return v};
  const email=text("email",b.email,320).toLowerCase();
  if(!email)fields.email="Email is required.";else if(!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))fields.email="Enter a valid email address.";
  let firstName=text("firstName",b.firstName,120),lastName=text("lastName",b.lastName,120);
  const fullName=text("fullName",b.fullName,240);
  if(fullName){const [first,...rest]=fullName.split(/\s+/);if(!firstName)firstName=first||"";if(!lastName)lastName=rest.join(" ")}
  const source=text("source",b.source,40) as UpsertSource;
  if(!Object.hasOwn(SOURCE_LABELS,source))fields.source=`Use one of: ${Object.keys(SOURCE_LABELS).join(", ")}.`;
  const reportName=text("reportName",b.reportName,200);
  if(source==="report_download"&&!reportName)fields.reportName="reportName is required for report_download.";
  let consent:boolean|null=null;
  if(typeof b.consent==="boolean")consent=b.consent;else if(b.consent!=null){const v=String(b.consent).trim().toLowerCase();if(TRUE.has(v))consent=true;else if(FALSE.has(v))consent=false;else fields.consent="Use true or false."}
  let note:UpsertInput["note"]=null;
  if(b.note!=null){if(typeof b.note!=="object"||Array.isArray(b.note))fields.note="Must be an object with title and body.";else{const n=b.note as Record<string,unknown>,title=text("note.title",n.title,200),noteBody=text("note.body",n.body,10000);if(title||noteBody)note={title,body:noteBody}}}
  const u=b.utm&&typeof b.utm==="object"&&!Array.isArray(b.utm)?b.utm as Record<string,unknown>:{};
  if(b.utm!=null&&(typeof b.utm!=="object"||Array.isArray(b.utm)))fields.utm="Must be an object.";
  const utm={source:text("utm.source",u.source,200),medium:text("utm.medium",u.medium,200),campaign:text("utm.campaign",u.campaign,200),term:text("utm.term",u.term,200),content:text("utm.content",u.content,200)};
  const lists:string[]=[];
  if(b.lists!=null){if(!Array.isArray(b.lists))fields.lists="Must be an array of list names.";else if(b.lists.length>10)fields.lists="At most 10 lists.";else{const seen=new Set<string>();for(const raw of b.lists){const name=typeof raw==="string"?raw.trim():"";if(!name||name.length>120){fields.lists="Each list name must be 1–120 characters.";break}if(!seen.has(name.toLowerCase())){seen.add(name.toLowerCase());lists.push(name)}}}}
  const submissionId=text("submissionId",b.submissionId,200);
  const value:UpsertInput={email,firstName,lastName,jobTitle:text("jobTitle",b.jobTitle,200),company:text("company",b.company,240),note,source,reportName,consent,consentText:text("consentText",b.consentText,1000),referrer:text("referrer",b.referrer,2000),utm,lists,submissionId};
  return Object.keys(fields).length?{ok:false,fields}:{ok:true,value};
}
