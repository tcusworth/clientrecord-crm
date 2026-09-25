import { env } from "cloudflare:workers";

type Json = Record<string, unknown>;

export function resendConfigured() {
  return Boolean(env.RESEND_API_KEY);
}

export async function resend(path: string, init: RequestInit = {}) {
  let requestBody:Json={};try{requestBody=typeof init.body==="string"?JSON.parse(init.body):{}}catch{}
  const log=async(message:string)=>{try{const to=Array.isArray(requestBody.to)?String(requestBody.to[0]||""):String(requestBody.to||"");await env.DB.prepare("INSERT INTO delivery_logs(provider,kind,status,recipient,subject,error,context,created_at) VALUES ('resend',?,'Failed',?,?,?,?,datetime('now'))").bind(path.includes("broadcast")?"campaign":"email",to,String(requestBody.subject||""),message,JSON.stringify({path})).run();}catch{}}
  if (!env.RESEND_API_KEY) {const message="Resend is not connected yet.";await log(message);throw new Error(message);}
  try{
    const response = await fetch(`https://api.resend.com${path}`, {...init,headers:{Authorization:`Bearer ${env.RESEND_API_KEY}`,"Content-Type":"application/json",...(init.headers||{})}});
    const data = await response.json().catch(() => ({})) as Json;
    if (!response.ok) {const message=typeof data.message==="string"?data.message:"Resend rejected the request.";await log(message);throw new Error(message);}
    return data;
  }catch(error){const message=error instanceof Error?error.message:"Resend request failed.";if(message!=="Resend rejected the request.")await log(message);throw error;}
}

export type SendingIdentity = {
  businessName: string;
  logoUrl: string;
  fromName: string;
  fromEmail: string;
  replyToEmail: string;
  sendingDomain: string;
  physicalAddress: string;
};

export async function sendingIdentity(): Promise<SendingIdentity> {
  const row = await env.DB.prepare("SELECT business_name AS businessName,logo_url AS logoUrl,from_name AS fromName,from_email AS fromEmail,reply_to_email AS replyToEmail,sending_domain AS sendingDomain,physical_address AS physicalAddress FROM brand_settings WHERE id=1").first<SendingIdentity>();
  const fallback = String(env.RESEND_FROM_EMAIL || "");
  const match = fallback.match(/^\s*(.*?)\s*<([^>]+)>\s*$/);
  return {
    businessName: row?.businessName || "",
    logoUrl: row?.logoUrl || "",
    fromName: row?.fromName || match?.[1] || "",
    fromEmail: row?.fromEmail || match?.[2] || fallback,
    replyToEmail: row?.replyToEmail || "",
    sendingDomain: row?.sendingDomain || "",
    physicalAddress: row?.physicalAddress || "",
  };
}

export function fromEmail(identity?: Pick<SendingIdentity, "fromName" | "fromEmail">) {
  if (identity?.fromEmail) return identity.fromName ? `${identity.fromName} <${identity.fromEmail}>` : identity.fromEmail;
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

// Signed manual-unsubscribe links. HMAC-SHA256 keyed off CRM_TOKEN_ENCRYPTION_KEY with a purpose prefix so the
// tag can never collide with other uses of that key.
const UNSUBSCRIBE_TOKEN_PURPOSE = "clientrecord:unsubscribe:v1:";
function normalizeEmail(email: string) { return email.trim().toLowerCase(); }
async function unsubscribeMac(email: string) {
  if (!env.CRM_TOKEN_ENCRYPTION_KEY) throw new Error("CRM_TOKEN_ENCRYPTION_KEY is not configured.");
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(env.CRM_TOKEN_ENCRYPTION_KEY), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(UNSUBSCRIBE_TOKEN_PURPOSE + normalizeEmail(email))));
}

export async function unsubscribeToken(email: string) {
  return btoa(String.fromCharCode(...await unsubscribeMac(email))).replaceAll("+","-").replaceAll("/","_").replaceAll("=","");
}

export async function unsubscribeUrl(email: string, origin: string) {
  return `${origin.replace(/\/+$/,"")}/unsubscribe?email=${encodeURIComponent(normalizeEmail(email))}&token=${await unsubscribeToken(email)}`;
}

export async function verifyUnsubscribeToken(email: string, token: string) {
  if (!env.CRM_TOKEN_ENCRYPTION_KEY || !email || !token) return false;
  const expected = new TextEncoder().encode(await unsubscribeToken(email)), actual = new TextEncoder().encode(token);
  let diff = expected.length ^ actual.length;
  for (let i = 0; i < expected.length; i++) diff |= expected[i] ^ (actual[i] ?? 0);
  return diff === 0;
}
