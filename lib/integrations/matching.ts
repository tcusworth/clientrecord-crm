import { env } from "cloudflare:workers";
import { DEFAULT_OWNER_EMAIL } from "@/lib/crm-auth";

// Shared by microsoft-sync and google-sync: which addresses are "us" (never CRM contacts) and which are external.
// Free-mail domains are never treated as one company, or a gmail.com mailbox would make every gmail contact internal.
const FREE_MAIL = new Set(["gmail.com", "googlemail.com", "outlook.com", "hotmail.com", "hotmail.co.uk", "live.com", "msn.com", "yahoo.com", "yahoo.co.uk", "icloud.com", "me.com", "mac.com", "aol.com", "proton.me", "protonmail.com", "pm.me", "gmx.com", "gmx.net", "gmx.de", "mail.com", "yandex.com", "zoho.com", "fastmail.com", "hey.com", "comcast.net", "att.net"]);
const norm = (value: unknown) => String(value ?? "").trim().toLowerCase();
const domainOf = (email: string) => email.split("@")[1] || "";

// own: the mailbox owner's addresses (own mailbox address first, then the CRM user_email). Internal = any of those,
// any team member (active or not), any CRM_ALLOWED_EMAILS owner, or anyone on the mailbox's own (non-free-mail) domain.
export async function loadInternalMatcher(own: Array<string | null | undefined>) {
  const ownAddresses = new Set(own.map(norm).filter(Boolean));
  const people = new Set(ownAddresses);
  for (const owner of String(env.CRM_ALLOWED_EMAILS || DEFAULT_OWNER_EMAIL).split(",")) if (norm(owner)) people.add(norm(owner));
  for (const row of (await env.DB.prepare("SELECT lower(email) AS email FROM team_members").all<{ email: string }>()).results) if (row.email) people.add(norm(row.email));
  const domain = domainOf(norm(own[0]));
  const ownDomain = domain && !FREE_MAIL.has(domain) ? domain : "";
  const isInternal = (email: string) => { const e = norm(email); return !e || people.has(e) || (!!ownDomain && domainOf(e) === ownDomain) };
  return { isOwn: (email: string) => ownAddresses.has(norm(email)), isInternal, external: (emails: string[]) => emails.map(norm).filter((e, i, all) => e && !isInternal(e) && all.indexOf(e) === i) };
}
