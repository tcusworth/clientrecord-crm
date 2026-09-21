import { env } from "cloudflare:workers";
import { verifyResendWebhook } from "@/lib/resend";

type Webhook = { type?: string; created_at?: string; data?: { broadcast_id?: string; email_id?: string; to?: string[] } };

export async function POST(request: Request) {
  const payload = await request.text();
  if (!(await verifyResendWebhook(payload, request.headers))) return new Response("Invalid webhook", { status: 400 });
  const event = JSON.parse(payload) as Webhook;
  const broadcastId = event.data?.broadcast_id;
  if (!broadcastId || !event.type?.startsWith("email.")) return Response.json({ accepted: true });
  const campaign = await env.DB.prepare("SELECT id FROM campaigns WHERE resend_broadcast_id=?").bind(broadcastId).first<{ id: number }>();
  if (!campaign) return Response.json({ accepted: true });
  const eventId = request.headers.get("svix-id") || `${event.type}:${event.data?.email_id}:${event.created_at}`;
  const recipient = event.data?.to?.[0] || null;
  const inserted = await env.DB.prepare("INSERT OR IGNORE INTO campaign_events (campaign_id,provider_event_id,type,email_id,recipient,occurred_at,payload) VALUES (?,?,?,?,?,?,?)").bind(campaign.id,eventId,event.type,event.data?.email_id||null,recipient,event.created_at||new Date().toISOString(),payload).run();
  if (Number(inserted.meta.changes || 0) === 0) return Response.json({ accepted: true, duplicate: true });
  const columns: Record<string,string> = { "email.delivered":"delivered_count", "email.opened":"opened_count", "email.clicked":"clicked_count", "email.bounced":"bounced_count", "email.complained":"complained_count" };
  const column = columns[event.type];
  if (column) await env.DB.prepare(`UPDATE campaigns SET ${column}=${column}+1,status='Sent',sent_at=COALESCE(sent_at,?),updated_at=datetime('now') WHERE id=?`).bind(event.created_at||new Date().toISOString(),campaign.id).run();
  if (recipient && (event.type === "email.bounced" || event.type === "email.complained" || event.type === "email.suppressed")) await env.DB.prepare("UPDATE contacts SET subscribed=0 WHERE email=?").bind(recipient.toLowerCase()).run();
  return Response.json({ accepted: true });
}
