import { env } from "cloudflare:workers";
import { crmUser } from "@/lib/crm-auth";
import { canConnectOwn } from "@/lib/integrations/accounts";
import { googleAuthorizeUrl, googleConfigured } from "@/lib/google";
export async function GET(request:Request){const user=await crmUser(request);if(!user)return Response.json({error:"Sign in is required."},{status:401});if(!canConnectOwn(user))return Response.json({error:"Edit permission is required to connect your Google account."},{status:403});if(!googleConfigured())return Response.redirect(new URL("/?integration=google_setup",request.url));const state=crypto.randomUUID();await env.DB.prepare("INSERT INTO oauth_states(state,actor_email,expires_at,created_at) VALUES (?,?,datetime('now','+10 minutes'),datetime('now'))").bind(state,user.email).run();return Response.redirect(googleAuthorizeUrl(new URL(request.url).origin,state));}
