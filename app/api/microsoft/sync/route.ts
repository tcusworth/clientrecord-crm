import { audit, crmUser } from "@/lib/crm-auth";
import { systemEvent } from "@/lib/operations";
import { canConnectOwn, ownAccount } from "@/lib/integrations/accounts";
import { ReconnectRequired, syncMicrosoftAccount } from "@/lib/integrations/microsoft-sync";

// Sync now: syncs the caller's OWN Microsoft account (records.edit); the mailbox owner is the actor.
export async function POST(request:Request){
 const user=await crmUser(request);if(!user)return Response.json({error:"Sign in is required."},{status:401});if(!canConnectOwn(user))return Response.json({error:"Edit permission is required to sync your Microsoft account."},{status:403});
 const account=await ownAccount("microsoft",user.email);if(!account)return Response.json({error:"Connect your Microsoft account first."},{status:404});
 try{
  const result=await syncMicrosoftAccount(account),{messages,meetings,replies,tasks,linked,attachments}=result;
  await audit(user,"integration.sync","integration",account.id,`Synced ${messages} emails and ${meetings} meetings`,{provider:"microsoft",messages,meetings,replies,tasks,linked,attachments,skipped:result.skipped,reviewQueued:result.reviewQueued});return Response.json(result);
 }catch(error){const message=error instanceof Error?error.message:"Microsoft synchronization failed.";await systemEvent("error","integration","microsoft",message,{accountId:account.id,userEmail:account.user_email});return Response.json({error:message},{status:error instanceof ReconnectRequired?409:500})}
}
