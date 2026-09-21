import { env } from "cloudflare:workers";
import { audit, canAdmin, crmUser } from "@/lib/crm-auth";
import { fromEmail, resend, sendingIdentity } from "@/lib/resend";

const clean = (value: unknown) => typeof value === "string" ? value.trim() : "";
const emailPattern = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const domainPattern = /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,}$/i;

async function connectionStatus(domain: string) {
  if (!env.RESEND_API_KEY) return { apiConnected: false, domainStatus: "Not connected", ready: false };
  if (!domain) return { apiConnected: true, domainStatus: "Add a sending domain", ready: false };
  try {
    const result = await resend("/domains");
    const domains = Array.isArray(result.data) ? result.data as Array<Record<string, unknown>> : [];
    const match = domains.find(item => String(item.name || "").toLowerCase() === domain.toLowerCase());
    const status = match ? String(match.status || "pending") : "Not found in Resend";
    return { apiConnected: true, domainStatus: status, ready: status.toLowerCase() === "verified" };
  } catch (error) {
    return { apiConnected: false, domainStatus: error instanceof Error ? error.message : "Connection check failed", ready: false };
  }
}

async function requireAdmin(request: Request) {
  const user = await crmUser(request);
  if (!user) return { user: null, response: Response.json({ error: "Sign in is required." }, { status: 401 }) };
  if (!canAdmin(user.role)) return { user: null, response: Response.json({ error: "Admin access is required." }, { status: 403 }) };
  return { user, response: null };
}

export async function GET(request: Request) {
  const auth = await requireAdmin(request); if (!auth.user) return auth.response;
  const settings = await sendingIdentity();
  return Response.json({ settings, connection: await connectionStatus(settings.sendingDomain) });
}

export async function POST(request: Request) {
  const auth = await requireAdmin(request); if (!auth.user) return auth.response;
  const body = await request.json() as Record<string, unknown>;
  const action = clean(body.action);
  if (action === "save") {
    const businessName = clean(body.businessName), logoUrl = clean(body.logoUrl), fromName = clean(body.fromName), fromAddress = clean(body.fromEmail).toLowerCase(), replyToEmail = clean(body.replyToEmail).toLowerCase(), sendingDomain = clean(body.sendingDomain).toLowerCase().replace(/^https?:\/\//, "").replace(/\/$/, ""), physicalAddress = clean(body.physicalAddress);
    if (!businessName || !fromName || !fromAddress || !sendingDomain || !physicalAddress) return Response.json({ error: "Business name, From name, From email, sending domain, and physical address are required." }, { status: 400 });
    if (!emailPattern.test(fromAddress) || (replyToEmail && !emailPattern.test(replyToEmail))) return Response.json({ error: "Enter valid From and reply-to email addresses." }, { status: 400 });
    if (!domainPattern.test(sendingDomain)) return Response.json({ error: "Enter a domain such as news.example.com without https://." }, { status: 400 });
    const fromDomain = fromAddress.split("@")[1];
    if (fromDomain !== sendingDomain) return Response.json({ error: `The From email must use ${sendingDomain}.` }, { status: 400 });
    if (logoUrl) { try { const url = new URL(logoUrl); if (url.protocol !== "https:") throw new Error(); } catch { return Response.json({ error: "Logo must be a public HTTPS image URL." }, { status: 400 }); } }
    await env.DB.prepare("INSERT INTO brand_settings (id,business_name,logo_url,from_name,from_email,reply_to_email,sending_domain,physical_address,updated_by,updated_at) VALUES (1,?,?,?,?,?,?,?,?,datetime('now')) ON CONFLICT(id) DO UPDATE SET business_name=excluded.business_name,logo_url=excluded.logo_url,from_name=excluded.from_name,from_email=excluded.from_email,reply_to_email=excluded.reply_to_email,sending_domain=excluded.sending_domain,physical_address=excluded.physical_address,updated_by=excluded.updated_by,updated_at=datetime('now')").bind(businessName, logoUrl, fromName, fromAddress, replyToEmail, sendingDomain, physicalAddress, auth.user.email).run();
    await audit(auth.user, "brand.save", "brand_settings", 1, `Updated sending identity for ${businessName}`, { businessName, fromAddress, replyToEmail, sendingDomain });
    return Response.json({ status: "saved", connection: await connectionStatus(sendingDomain) });
  }
  if (action === "test") {
    const to = clean(body.to).toLowerCase(); if (!emailPattern.test(to)) return Response.json({ error: "Enter a valid test email address." }, { status: 400 });
    const settings = await sendingIdentity();
    if (!settings.fromEmail || !settings.businessName || !settings.physicalAddress) return Response.json({ error: "Save complete Brand & Sending Settings before sending a test." }, { status: 400 });
    const logo = settings.logoUrl ? `<img src="${settings.logoUrl.replaceAll('"', '&quot;')}" alt="${settings.businessName.replaceAll('"', '&quot;')}" style="display:block;max-width:180px;max-height:72px;margin:0 0 24px">` : "";
    const html = `<div style="background:#f3f5f8;padding:32px"><div style="max-width:600px;margin:auto;background:#fff;border-radius:14px;padding:36px;font:16px/1.6 Arial,sans-serif;color:#111b31">${logo}<h1 style="margin:0 0 12px">Your sending identity is ready</h1><p>This test was sent from <strong>${fromEmail(settings)}</strong>${settings.replyToEmail ? ` with replies directed to <strong>${settings.replyToEmail}</strong>` : ""}.</p><p style="margin-top:28px;font-size:12px;color:#667085">${settings.businessName}<br>${settings.physicalAddress.replaceAll("\n", "<br>")}</p></div></div>`;
    const result = await resend("/emails", { method: "POST", body: JSON.stringify({ from: fromEmail(settings), to: [to], reply_to: settings.replyToEmail || undefined, subject: `[TEST] ${settings.businessName} sending identity`, html }) });
    await audit(auth.user, "brand.test", "brand_settings", 1, `Sent a brand test email to ${to}`);
    return Response.json({ status: "sent", id: result.id });
  }
  return Response.json({ error: "Unknown action." }, { status: 400 });
}
