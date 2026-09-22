import { apiKeyUser } from "@/lib/crm-auth";
import { ingestMeetilyWebhook } from "@/lib/meetily-webhook";

type Row=Record<string,unknown>;

export async function GET(request:Request){
  const user=await apiKeyUser(request,"meetings.import");
  if(!user)return Response.json({error:"A valid ClientRecord meetings.import token is required."},{status:401});
  return Response.json({ok:true,service:"ClientRecord Meetily receiver",scope:"meetings.import"});
}

export async function POST(request:Request){
  const user=await apiKeyUser(request,"meetings.import");if(!user)return Response.json({error:"A valid ClientRecord meetings.import token is required."},{status:401});
  try{const contentType=request.headers.get("content-type")||"";if(!contentType.toLowerCase().includes("application/json"))return Response.json({error:"Send the meeting as application/json."},{status:415});const body=await request.json() as Row,result=await ingestMeetilyWebhook(body,user);return Response.json(result,{status:result.status==="Imported"?201:202});}
  catch(error){console.error("Meetily webhook failed",error);return Response.json({error:error instanceof Error?error.message:"The Meetily meeting could not be imported."},{status:400})}
}
