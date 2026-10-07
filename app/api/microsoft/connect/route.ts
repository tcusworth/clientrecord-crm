import { env } from "cloudflare:workers";
import { crmUser } from "@/lib/crm-auth";
import { canConnectOwn } from "@/lib/integrations/accounts";
import { authorizeUrl, microsoftConfigured } from "@/lib/microsoft";

export async function GET(request: Request) {
  const user = await crmUser(request); if (!user) return Response.redirect(new URL("/?integration=sign_in_required", request.url));
  if (!canConnectOwn(user)) return Response.json({ error: "Edit permission is required to connect your Microsoft account." }, { status: 403 });
  if (!microsoftConfigured()) return Response.json({ error: "Microsoft 365 credentials have not been configured yet." }, { status: 503 });
  const state = crypto.randomUUID(); await env.DB.prepare("DELETE FROM oauth_states WHERE expires_at<datetime('now')").run();
  await env.DB.prepare("INSERT INTO oauth_states (state,actor_email,expires_at,created_at) VALUES (?,?,datetime('now','+10 minutes'),datetime('now'))").bind(state, user.email).run();
  return Response.redirect(authorizeUrl(new URL(request.url).origin, state));
}
