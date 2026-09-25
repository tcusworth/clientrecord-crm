import { apiKeyUser, can, crmUser } from "@/lib/crm-auth";
import { captureInboxMessage, type InboxInput } from "@/lib/revenue-ops";

export async function POST(request:Request){
  const session=await crmUser(request);if(session&&!can(session,"records.edit"))return Response.json({error:"Record-edit permission is required."},{status:403});const user=session||await apiKeyUser(request,"inbox.capture");if(!user)return Response.json({error:"Sign in or use an inbox.capture API key."},{status:401});
  try{const body=await request.json() as InboxInput,result=await captureInboxMessage(body,user);return Response.json(result,{status:201});}catch(error){return Response.json({error:error instanceof Error?error.message:"Inbox capture failed."},{status:400});}
}
