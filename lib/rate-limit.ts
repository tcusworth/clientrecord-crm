import { env } from "cloudflare:workers";
import { sha256 } from "@/lib/crm-auth";

const CLEANUP_PROBABILITY = 0.05, RETENTION_SECONDS = 3600;

// Fixed-window limiter in D1 keyed by route + SHA-256(client IP). Returns a 429 Response when the caller is over
// the limit, otherwise null. Fails open (logged) if D1 is unavailable so public links keep working.
export async function rateLimit(request: Request, route: string, limit: number, windowSeconds = 60): Promise<Response | null> {
  const now = Math.floor(Date.now() / 1000), windowStart = now - (now % windowSeconds);
  const key = `${route}:${await sha256(request.headers.get("cf-connecting-ip")?.trim() || "unknown")}`;
  try {
    const row = await env.DB.prepare("INSERT INTO rate_limits(key,window_start,count) VALUES (?,?,1) ON CONFLICT(key) DO UPDATE SET count=CASE WHEN rate_limits.window_start=excluded.window_start THEN rate_limits.count+1 ELSE 1 END,window_start=excluded.window_start RETURNING count").bind(key, windowStart).first<{ count: number }>();
    if (Math.random() < CLEANUP_PROBABILITY) await env.DB.prepare("DELETE FROM rate_limits WHERE window_start<?").bind(now - RETENTION_SECONDS).run();
    if (Number(row?.count || 0) <= limit) return null;
  } catch (error) { console.error("Rate limiter unavailable", error); return null; }
  const retryAfter = windowStart + windowSeconds - now;
  return Response.json({ error: "Too many requests. Please wait a minute and try again." }, { status: 429, headers: { "retry-after": String(Math.max(1, retryAfter)) } });
}
