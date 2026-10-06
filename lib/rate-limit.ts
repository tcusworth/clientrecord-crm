import { env } from "cloudflare:workers";
import { sha256 } from "@/lib/crm-auth";

const CLEANUP_PROBABILITY = 0.05, RETENTION_SECONDS = 3600;

// Fixed-window counter in D1 for an arbitrary key. Fails open (logged) if D1 is unavailable.
export async function rateLimitKey(key: string, limit: number, windowSeconds = 60): Promise<{ limited: boolean; retryAfter: number }> {
  const now = Math.floor(Date.now() / 1000), windowStart = now - (now % windowSeconds), retryAfter = Math.max(1, windowStart + windowSeconds - now);
  try {
    const row = await env.DB.prepare("INSERT INTO rate_limits(key,window_start,count) VALUES (?,?,1) ON CONFLICT(key) DO UPDATE SET count=CASE WHEN rate_limits.window_start=excluded.window_start THEN rate_limits.count+1 ELSE 1 END,window_start=excluded.window_start RETURNING count").bind(key, windowStart).first<{ count: number }>();
    if (Math.random() < CLEANUP_PROBABILITY) await env.DB.prepare("DELETE FROM rate_limits WHERE window_start<?").bind(now - RETENTION_SECONDS).run();
    return { limited: Number(row?.count || 0) > limit, retryAfter };
  } catch (error) { console.error("Rate limiter unavailable", error); return { limited: false, retryAfter }; }
}

// Fixed-window limiter keyed by route + SHA-256(client IP). Returns a 429 Response when over the limit, otherwise null.
export async function rateLimit(request: Request, route: string, limit: number, windowSeconds = 60): Promise<Response | null> {
  const result = await rateLimitKey(`${route}:${await sha256(request.headers.get("cf-connecting-ip")?.trim() || "unknown")}`, limit, windowSeconds);
  return result.limited ? Response.json({ error: "Too many requests. Please wait a minute and try again." }, { status: 429, headers: { "retry-after": String(result.retryAfter) } }) : null;
}
