import { apiKeyAccess } from "@/lib/crm-auth";
import { parseUpsertInput } from "@/lib/contact-upsert-input";
import { upsertContact } from "@/lib/contact-upsert";
const MAX=20*1024,RETRY={error:"Temporary failure; retry."};
const message=(e:unknown)=>e instanceof Error?e.message:String(e);
const transient=(e:unknown)=>/overloaded|timeout|7429|D1_ERROR.*(busy|reset)/i.test(message(e));
const uniqueRace=(e:unknown)=>/UNIQUE constraint failed/i.test(message(e));
export async function POST(request:Request){
  const access=await apiKeyAccess(request,"leads.capture");
  if("status" in access)return Response.json({error:access.status===401?"A valid leads.capture API key is required.":"This API key lacks the leads.capture scope."},{status:access.status});
  const raw=await request.text();
  if(new TextEncoder().encode(raw).length>MAX)return Response.json({error:"Payload exceeds 20 KB."},{status:413});
  let body:unknown;try{body=JSON.parse(raw)}catch{return Response.json({error:"Body must be valid JSON.",fields:{body:"Invalid JSON."}},{status:400})}
  const parsed=parseUpsertInput(body);
  if(!parsed.ok)return Response.json({error:"Invalid payload.",fields:parsed.fields},{status:400});
  const respond=(result:Awaited<ReturnType<typeof upsertContact>>)=>Response.json(result,{status:result.action==="created"?201:200});
  try{return respond(await upsertContact(parsed.value,access.user))}
  catch(first){
    let error=first;
    // A concurrent request won a unique index (submission_id or contact email); the retry then finds an update or a duplicate.
    if(uniqueRace(first)){try{return respond(await upsertContact(parsed.value,access.user))}catch(second){error=second}}
    console.error("contact upsert failed",message(error));
    return Response.json(RETRY,{status:transient(error)?503:500});
  }
}
