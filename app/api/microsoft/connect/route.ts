import { env } from "cloudflare:workers";
import { can, crmUser } from "@/lib/crm-auth";
import { authorizeUrl, microsoftConfigured } from "@/lib/microsoft";

export async function GET(request: Request) {
  const user = await crmUser(request); if (!user) return Response.redirect(new URL("/signin-with-chatgpt?return_to=%2F", request.url));
  if (!can(user,"integrations.manage")) return Response.json({ error: "Integration permission is required." }, { status: 403 });
  if (!microsoftConfigured()) return Response.json({ error: "Microsoft 365 credentials have not been configured yet." }, { status: 503 });
  const state = crypto.randomUUID(); await env.DB.prepare("DELETE FROM oauth_states WHERE expires_at<datetime('now')").run();
  await env.DB.prepare("INSERT INTO oauth_states (state,actor_email,expires_at,created_at) VALUES (?,?,datetime('now','+10 minutes'),datetime('now'))").bind(state, user.email).run();
  return Response.redirect(authorizeUrl(new URL(request.url).origin, state));
}
