import { env } from "cloudflare:workers";
import { can, crmUser } from "@/lib/crm-auth";
import { createRenewalDeal, saveCustomerSuccessPlan } from "@/lib/customer-success";

type Row=Record<string,unknown>;
const clean=(value:unknown,max=100)=>String(value??"").trim().slice(0,max);
const rows=async(sql:string,...args:(string|number|null)[])=>(await env.DB.prepare(sql).bind(...args).all()).results as Row[];

export async function GET(request:Request){
 const user=await crmUser(request);if(!user)return Response.json({error:"Sign in is required."},{status:401});if(!can(user,"records.view"))return Response.json({error:"View access is required."},{status:403});
 try{const [plans,companies,renewalDeals,alerts]=await Promise.all([
  rows("SELECT p.*,c.name AS company_name,c.industry,c.owner AS company_owner,COALESCE((SELECT max(happened_at) FROM deal_activities da JOIN deals d ON d.id=da.deal_id WHERE d.company_id=p.company_id),c.updated_at) AS last_engagement FROM customer_success_plans p JOIN companies c ON c.id=p.company_id ORDER BY CASE WHEN p.churn_risk IN ('Critical','High') THEN 0 ELSE 1 END,p.renewal_date ASC"),
  rows("SELECT c.id,c.name,c.owner,c.industry,c.stage FROM companies c WHERE c.stage='Customer' OR EXISTS(SELECT 1 FROM contacts ct WHERE lower(ct.company)=lower(c.name) AND ct.stage='Customer') ORDER BY c.name LIMIT 800"),
  rows("SELECT id,name,company,company_id AS companyId,stage,status,value,close_date AS closeDate,owner FROM deals WHERE pipeline_key='renewals' OR lower(stage) LIKE '%renewal%' ORDER BY close_date ASC LIMIT 300"),
  rows("SELECT p.id,c.name AS companyName,p.churn_risk AS churnRisk,p.health_score AS healthScore,p.renewal_date AS renewalDate,p.owner FROM customer_success_plans p JOIN companies c ON c.id=p.company_id WHERE p.status<>'Churned' AND (p.churn_risk IN ('High','Critical') OR p.health_score<40 OR (p.renewal_date IS NOT NULL AND date(p.renewal_date)<=date('now','+90 days'))) ORDER BY p.renewal_date ASC LIMIT 120"),
 ]);return Response.json({account:{email:user.email},plans,companies,renewalDeals,alerts});}
 catch(error){console.error(error);return Response.json({error:"Customer success records could not load."},{status:503});}
}

export async function POST(request:Request){
 const user=await crmUser(request);if(!user)return Response.json({error:"Sign in is required."},{status:401});if(!can(user,"records.edit"))return Response.json({error:"Edit access is required."},{status:403});
 try{const body=await request.json() as Row,action=clean(body.action);
  if(action==="savePlan")return Response.json(await saveCustomerSuccessPlan(body,user),{status:201});
  if(action==="createRenewalDeal")return Response.json(await createRenewalDeal(clean(body.id),user),{status:201});
  throw new Error("Unknown customer success action.");
 }catch(error){return Response.json({error:error instanceof Error?error.message:"The customer plan could not be saved."},{status:400});}
}
