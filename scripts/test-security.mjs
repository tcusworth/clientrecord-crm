import assert from "node:assert/strict";
import { createTestContext } from "./test-helpers.mjs";

const {sqlite,env,load}=createTestContext({CRM_TOKEN_ENCRYPTION_KEY:"test-encryption-key-0123456789abcdef"});
sqlite.exec("CREATE TABLE IF NOT EXISTS rate_limits(key text PRIMARY KEY NOT NULL,window_start integer NOT NULL,count integer DEFAULT 0 NOT NULL);CREATE INDEX IF NOT EXISTS rate_limits_window ON rate_limits(window_start)");
const auth=load("lib/crm-auth.ts");
const sitesHeaders=email=>({"oai-authenticated-user-id":"test-user","oai-authenticated-user-email":email,"content-type":"application/json"});
const reset=()=>{delete env.CF_ACCESS_TEAM_DOMAIN;delete env.CF_ACCESS_AUD;delete env.CF_ACCESS_ENFORCED};

// 1. Localhost owner bypass exists only when the Vite dev server sets NODE_ENV=development.
const originalNodeEnv=process.env.NODE_ENV;
try{
  delete process.env.NODE_ENV;
  for(const host of ["localhost","127.0.0.1","terminal.local"])assert.equal(await auth.crmUser(new Request(`http://${host}/api/crm`)),null,`${host} must not bypass auth outside dev`);
  process.env.NODE_ENV="production";assert.equal(await auth.crmUser(new Request("http://localhost/api/crm")),null);
  process.env.NODE_ENV="development";const local=await auth.crmUser(new Request("http://localhost/api/crm"));assert.equal(local.role,"owner");assert.equal(local.email,auth.DEFAULT_OWNER_EMAIL);
  assert.equal(await auth.crmUser(new Request("https://crm.example.com/api/crm")),null,"non-local hosts never bypass");
}finally{if(originalNodeEnv===undefined)delete process.env.NODE_ENV;else process.env.NODE_ENV=originalNodeEnv}

// 2. Platform identity headers: opt-in via TRUST_PLATFORM_IDENTITY_HEADERS="true", and then trusted only when Access is
// unconfigured, or explicitly relaxed with CF_ACCESS_ENFORCED=false.
const headerUser=()=>auth.crmUser(new Request("https://crm.example.com/api/crm",{headers:sitesHeaders("owner@example.com")}));
reset();delete env.TRUST_PLATFORM_IDENTITY_HEADERS;assert.equal(await headerUser(),null,"flag unset (default): headers ignored");
for(const value of ["false","TRUE","1","yes"," "]){env.TRUST_PLATFORM_IDENTITY_HEADERS=value;assert.equal(await headerUser(),null,`flag ${JSON.stringify(value)}: headers ignored`);}
env.CF_ACCESS_ENFORCED="false";env.TRUST_PLATFORM_IDENTITY_HEADERS="false";assert.equal(await headerUser(),null,"ENFORCED=false alone never enables header trust");
reset();env.TRUST_PLATFORM_IDENTITY_HEADERS="true";
assert.equal((await headerUser())?.role,"owner","flag on, Access not configured: platform headers trusted");
env.CF_ACCESS_ENFORCED="true";assert.equal(await headerUser(),null,"ENFORCED=true rejects headers");
reset();env.CF_ACCESS_TEAM_DOMAIN="https://team.cloudflareaccess.com";env.CF_ACCESS_AUD="aud";assert.equal(await headerUser(),null,"Access configured, ENFORCED unset: headers rejected");
env.CF_ACCESS_ENFORCED="FALSE";assert.equal((await headerUser())?.role,"owner","Access configured, ENFORCED=false: escape hatch");
env.CF_ACCESS_ENFORCED="yes";assert.equal(await headerUser(),null,"anything but an explicit false keeps headers untrusted");
reset();env.CF_ACCESS_TEAM_DOMAIN="https://team.cloudflareaccess.com";assert.equal((await headerUser())?.role,"owner","partial Access config counts as unconfigured");
reset();

// 3. API key scopes map to least-privilege permissions, never admin.
assert.deepEqual(auth.apiKeyPermissions(["records.read"]),["records.view"]);
assert.deepEqual(auth.apiKeyPermissions(["records.write"]),["records.view","records.edit"]);
for(const scope of ["leads.capture","inbox.capture","meetings.import"])assert.deepEqual(auth.apiKeyPermissions([scope]),["records.view","records.edit"]);
assert.deepEqual(auth.apiKeyPermissions(["jobs.run"]),["jobs.run"]);
assert.deepEqual(auth.apiKeyPermissions(["*"]).sort(),["jobs.run","records.edit","records.view"]);
assert.deepEqual(auth.apiKeyPermissions(["settings.manage","bogus"]),[]);
async function apiKey(scopes){const raw=`cr_live_${crypto.randomUUID()}`;sqlite.prepare("INSERT INTO api_keys(id,name,key_hash,key_prefix,scopes,created_by,created_at) VALUES (?,?,?,?,?,?,datetime('now'))").run(crypto.randomUUID(),"test",await auth.sha256(raw),raw.slice(0,16),scopes,"owner@example.com");return raw}
const keyRequest=raw=>new Request("https://crm.example.com/api/v1/records",{headers:{authorization:`Bearer ${raw}`}});
const readKey=await apiKey("records.read"),star=await apiKey("*"),jobs=await apiKey("jobs.run");
let user=await auth.apiKeyUser(keyRequest(readKey),"records.read");assert.equal(auth.canAdmin(user.role),false);assert.equal(auth.can(user,"records.view"),true);assert.equal(auth.can(user,"records.edit"),false);assert.equal(auth.canEdit(user.role),false);
assert.equal(await auth.apiKeyUser(keyRequest(readKey),"records.write"),null,"scope still gates the route");
user=await auth.apiKeyUser(keyRequest(star),"records.write");assert.equal(auth.canAdmin(user.role),false);for(const permission of ["settings.manage","integrations.manage","webhooks.manage","backups.manage","records.delete","campaigns.send"])assert.equal(auth.can(user,permission),false,permission);assert.equal(auth.can(user,"records.edit"),true);assert.equal(auth.can(user,"jobs.run"),true);
user=await auth.apiKeyUser(keyRequest(jobs),"jobs.run");assert.deepEqual(user.permissions,["jobs.run"]);assert.equal(auth.can(user,"records.view"),false);

// 4. createApiKey validates scopes against the allowlist; "*" is owner-only.
const operations=load("app/api/operations/route.ts");
sqlite.exec("INSERT INTO team_members(email,name,role,created_at,updated_at) VALUES ('admin@example.com','Ada Admin','admin','now','now')");
async function createKey(scopes,email="owner@example.com"){const response=await operations.POST(new Request("https://crm.example.com/api/operations",{method:"POST",headers:sitesHeaders(email),body:JSON.stringify({action:"createApiKey",name:"k",scopes})}));return{status:response.status,body:await response.json()}}
assert.equal((await createKey("records.read,settings.manage")).status,400);
assert.equal((await createKey("*","admin@example.com")).status,403);
assert.equal((await createKey("records.read, jobs.run","admin@example.com")).status,201);
const created=await createKey("*");assert.equal(created.status,201);assert.equal(created.body.scopes,"*");

// 5. Signed unsubscribe tokens.
const resend=load("lib/resend.ts"),token=await resend.unsubscribeToken("Person@Example.com");
assert.match(token,/^[A-Za-z0-9_-]{43}$/);
assert.equal(await resend.verifyUnsubscribeToken("person@example.com",token),true,"case-insensitive email");
assert.equal(await resend.verifyUnsubscribeToken("other@example.com",token),false);
assert.equal(await resend.verifyUnsubscribeToken("person@example.com",token.slice(0,-1)+(token.endsWith("A")?"B":"A")),false);
assert.equal(await resend.verifyUnsubscribeToken("person@example.com",""),false);
assert.equal(await resend.unsubscribeUrl("person@example.com","https://crm.example.com/"),`https://crm.example.com/unsubscribe?email=person%40example.com&token=${token}`);
const savedKey=env.CRM_TOKEN_ENCRYPTION_KEY;delete env.CRM_TOKEN_ENCRYPTION_KEY;assert.equal(await resend.verifyUnsubscribeToken("person@example.com",token),false,"no key, no verification");env.CRM_TOKEN_ENCRYPTION_KEY=savedKey;
const unsubscribe=load("app/api/unsubscribe/route.ts");
const unsub=(body,ip="198.51.100.1")=>unsubscribe.POST(new Request("https://crm.example.com/api/unsubscribe",{method:"POST",headers:{"content-type":"application/json","cf-connecting-ip":ip},body:JSON.stringify(body)}));
assert.equal((await unsub({email:"person@example.com"})).status,403);
assert.equal((await unsub({email:"victim@example.com",token})).status,403);
assert.equal(sqlite.prepare("SELECT count(*) count FROM suppressions").get().count,0);
assert.equal((await unsub({email:"person@example.com",token})).status,200);
assert.equal(sqlite.prepare("SELECT count(*) count FROM suppressions WHERE email='person@example.com' AND removed_at IS NULL").get().count,1);

// 6. D1 rate limiter: per route + hashed IP, fixed window, 429 with retry-after.
const {rateLimit}=load("lib/rate-limit.ts"),limitRequest=ip=>new Request("https://crm.example.com/api/portal",{headers:{"cf-connecting-ip":ip}});
const realNow=Date.now;let clock=Math.floor(realNow()/60000)*60000+1000;Date.now=()=>clock;
try{
  for(let i=0;i<5;i++)assert.equal(await rateLimit(limitRequest("203.0.113.9"),"test",5),null);
  const blocked=await rateLimit(limitRequest("203.0.113.9"),"test",5);assert.equal(blocked.status,429);assert.ok(Number(blocked.headers.get("retry-after"))>0);assert.match((await blocked.json()).error,/Too many requests/);
  assert.equal(await rateLimit(limitRequest("203.0.113.10"),"test",5),null,"other IPs unaffected");
  assert.equal(await rateLimit(limitRequest("203.0.113.9"),"other-route",5),null,"other routes unaffected");
  assert.equal(sqlite.prepare("SELECT count(*) count FROM rate_limits WHERE key LIKE '%203.0.113.9%'").get().count,0,"raw IPs are never stored");
  clock+=60000;assert.equal(await rateLimit(limitRequest("203.0.113.9"),"test",5),null,"new window resets the count");
  sqlite.prepare("INSERT INTO rate_limits(key,window_start,count) VALUES ('stale',0,99)").run();const random=Math.random;Math.random=()=>0;try{await rateLimit(limitRequest("203.0.113.11"),"test",5)}finally{Math.random=random}
  assert.equal(sqlite.prepare("SELECT count(*) count FROM rate_limits WHERE key='stale'").get().count,0,"old windows are cleaned up");
  for(let i=0;i<10;i++)await unsub({email:"x@example.com",token:"bad"},"192.0.2.50");assert.equal((await unsub({email:"x@example.com",token:"bad"},"192.0.2.50")).status,429,"unsubscribe is limited to 10/min");
}finally{Date.now=realNow}

console.log("PASS: dev-only localhost bypass, opt-in platform header trust rules, API key scope permissions, API key scope validation, signed unsubscribe tokens, and D1 rate limiting.");
