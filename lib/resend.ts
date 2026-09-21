import { env } from "cloudflare:workers";

type Json = Record<string, unknown>;

export function resendConfigured() {
  return Boolean(env.RESEND_API_KEY && env.RESEND_FROM_EMAIL);
}

export async function resend(path: string, init: RequestInit = {}) {
  if (!env.RESEND_API_KEY) throw new Error("Resend is not connected yet.");
  const response = await fetch(`https://api.resend.com${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${env.RESEND_API_KEY}`,
      "Content-Type": "application/json",
      ...(init.headers || {}),
    },
  });
  const data = await response.json().catch(() => ({})) as Json;
  if (!response.ok) throw new Error(typeof data.message === "string" ? data.message : "Resend rejected the request.");
  return data;
}

export function fromEmail() {
  if (!env.RESEND_FROM_EMAIL) throw new Error("A verified Resend sender has not been configured.");
  return env.RESEND_FROM_EMAIL;
}

function decodeSecret(secret: string) {
  const value = secret.startsWith("whsec_") ? secret.slice(6) : secret;
  const binary = atob(value);
  return Uint8Array.from(binary, char => char.charCodeAt(0));
}

export async function verifyResendWebhook(payload: string, headers: Headers) {
  if (!env.RESEND_WEBHOOK_SECRET) return false;
  const id = headers.get("svix-id"), timestamp = headers.get("svix-timestamp"), signature = headers.get("svix-signature");
  if (!id || !timestamp || !signature) return false;
  if (Math.abs(Date.now() / 1000 - Number(timestamp)) > 300) return false;
  const key = await crypto.subtle.importKey("raw", decodeSecret(env.RESEND_WEBHOOK_SECRET), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const signed = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`${id}.${timestamp}.${payload}`));
  const expected = btoa(String.fromCharCode(...new Uint8Array(signed)));
  return signature.split(" ").some(part => part === `v1,${expected}`);
}
