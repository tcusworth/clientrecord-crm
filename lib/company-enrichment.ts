export type CompanyEnrichmentProposal = {
  website:string;
  domain:string;
  summary:string;
  industry:string;
  headquarters:string;
  linkedin_url:string;
  logo_url:string;
  employee_range:string;
  source:string;
  confidence:number;
  evidence:string[];
};
type ApolloOrganization=Record<string,unknown>;

const publicEmailDomains=new Set(["aol.com","gmail.com","googlemail.com","hotmail.com","icloud.com","live.com","mail.com","me.com","msn.com","outlook.com","proton.me","protonmail.com","yahoo.com","ymail.com"]);
const blockedHosts=new Set(["0.0.0.0","127.0.0.1","localhost","metadata.google.internal"]);

export function normalizedCompanyDomain(value:unknown){
  const raw=String(value||"").trim().toLowerCase().replace(/^https?:\/\//,"").replace(/^www\./,"").split(/[\/?#]/)[0].replace(/:\d+$/,"");
  if(!raw||publicEmailDomains.has(raw)||blockedHosts.has(raw)||raw.endsWith(".local")||raw.endsWith(".internal")||!raw.includes(".")||!/^([a-z0-9-]+\.)+[a-z]{2,}$/i.test(raw))return "";
  return raw;
}

export function chooseCompanyDomain(existingDomain:unknown,website:unknown,emails:unknown[]){
  const candidates=[existingDomain,website,...emails.map(email=>String(email||"").split("@").pop())];
  for(const candidate of candidates){const domain=normalizedCompanyDomain(candidate);if(domain)return domain}
  return "";
}

function decode(value:string){return value.replace(/&amp;/gi,"&").replace(/&quot;/gi,'"').replace(/&#39;|&apos;/gi,"'").replace(/&lt;/gi,"<").replace(/&gt;/gi,">").replace(/\s+/g," ").trim()}
function text(value:unknown,max=1000){return decode(String(value||"").replace(/<[^>]+>/g," ")).slice(0,max)}
function meta(html:string,name:string){
  const escaped=name.replace(/[.*+?^${}()|[\]\\]/g,"\\$&");
  const patterns=[new RegExp(`<meta[^>]+(?:name|property)=["']${escaped}["'][^>]+content=["']([^"']*)["'][^>]*>`,`i`),new RegExp(`<meta[^>]+content=["']([^"']*)["'][^>]+(?:name|property)=["']${escaped}["'][^>]*>`,`i`)];
  for(const pattern of patterns){const match=html.match(pattern);if(match?.[1])return text(match[1],2000)}return "";
}
function absoluteUrl(value:string,base:string){try{const url=new URL(value,base);return url.protocol==="https:"||url.protocol==="http:"?url.toString():""}catch{return ""}}
function jsonLdObjects(html:string){
  const objects:Record<string,unknown>[]=[];
  for(const match of html.matchAll(/<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)){
    try{const parsed=JSON.parse(match[1]);const queue=Array.isArray(parsed)?[...parsed]:[parsed];while(queue.length){const item=queue.shift();if(!item||typeof item!=="object")continue;const record=item as Record<string,unknown>;objects.push(record);if(Array.isArray(record["@graph"]))queue.push(...record["@graph"])} }catch{}
  }
  return objects.slice(0,50);
}
function organization(html:string){return jsonLdObjects(html).find(item=>String(item["@type"]||"").toLowerCase().includes("organization"))||{} }
function address(value:unknown){
  if(typeof value==="string")return text(value,300);if(!value||typeof value!=="object")return "";
  const row=value as Record<string,unknown>;return [row.streetAddress,row.addressLocality,row.addressRegion,row.postalCode,row.addressCountry].map(v=>text(v,120)).filter(Boolean).join(", ");
}
function employeeRange(value:unknown){
  if(typeof value==="number"||typeof value==="string")return text(value,80);if(!value||typeof value!=="object")return "";
  const row=value as Record<string,unknown>,min=text(row.minValue,30),max=text(row.maxValue,30),exact=text(row.value,30);return exact||(min&&max?`${min}–${max}`:min||max);
}
function inferIndustry(content:string){
  const source=content.toLowerCase();const matches:Array<[string,RegExp]>=[
    ["Industrial Automation",/industrial automation|control system|process automation|manufacturing automation/],
    ["Engineering Services",/engineering services|systems integrator|engineering consultancy/],
    ["Energy",/oil and gas|renewable energy|energy company|power generation/],
    ["Food & Beverage",/food and beverage|food manufacturing|beverage production/],
    ["Life Sciences",/pharmaceutical|biotechnology|life sciences|medical device/],
    ["Cybersecurity",/cybersecurity|cyber security|information security/],
    ["Software",/software platform|software company|saas|cloud software/],
    ["Manufacturing",/manufacturer|manufacturing company|production facilities/],
  ];
  return matches.find(([,pattern])=>pattern.test(source))?.[0]||"";
}
async function fetchHtml(startUrl:string){
  let current=startUrl;
  for(let redirects=0;redirects<4;redirects++){
    const parsed=new URL(current),domain=normalizedCompanyDomain(parsed.hostname);if(!domain)throw new Error("The company website address is not safe to request.");
    const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),9000);
    let response:Response;
    try{response=await fetch(parsed.toString(),{redirect:"manual",signal:controller.signal,headers:{accept:"text/html,application/xhtml+xml","user-agent":"ClientRecordCRM-Enrichment/1.0"}})}finally{clearTimeout(timer)}
    if(response.status>=300&&response.status<400){const location=response.headers.get("location");if(!location)throw new Error("The company website returned an incomplete redirect.");current=new URL(location,current).toString();continue}
    if(!response.ok)throw new Error(`The company website returned HTTP ${response.status}.`);
    if(!String(response.headers.get("content-type")||"").toLowerCase().includes("text/html"))throw new Error("The company website did not return an HTML page.");
    const reader=response.body?.getReader(),decoder=new TextDecoder();let html="",received=0;
    if(reader){while(received<750000){const chunk=await reader.read();if(chunk.done)break;received+=chunk.value.byteLength;html+=decoder.decode(chunk.value,{stream:true})}await reader.cancel().catch(()=>{});html+=decoder.decode()}
    else html=(await response.text()).slice(0,750000);
    return {html,finalUrl:response.url||current};
  }
  throw new Error("The company website redirected too many times.");
}

export async function enrichCompanyWebsite(domain:string,website?:string):Promise<CompanyEnrichmentProposal>{
  const safeDomain=normalizedCompanyDomain(domain||website);if(!safeDomain)throw new Error("Add a company website or a business-email contact before enrichment.");
  const requested=website&&/^https?:\/\//i.test(website)?website:`https://${safeDomain}`;
  let fetched:{html:string;finalUrl:string};try{fetched=await fetchHtml(requested)}catch(error){if(website||!requested.startsWith("https://"))throw error;fetched=await fetchHtml(`http://${safeDomain}`)}
  const {html,finalUrl}=fetched,org=organization(html),pageTitle=text(html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1],240),summary=text(org.description||meta(html,"description")||meta(html,"og:description"),1200);
  const sameAs=Array.isArray(org.sameAs)?org.sameAs.map(String):[],linkMatches=Array.from(html.matchAll(/href=["']([^"']*linkedin\.com\/company\/[^"'#?]+)[^"']*["']/gi)).map(match=>match[1]);
  const linkedin=[...sameAs,...linkMatches].map(value=>absoluteUrl(value,finalUrl)).find(value=>value.includes("linkedin.com/company/"))||"";
  const logoValue=typeof org.logo==="object"&&org.logo?String((org.logo as Record<string,unknown>).url||""):String(org.logo||meta(html,"og:image")||"");
  const logo=absoluteUrl(logoValue,finalUrl),industry=text(org.industry,160)||inferIndustry([summary,pageTitle,text(org.name,240)].join(" ")),headquarters=address(org.address),employees=employeeRange(org.numberOfEmployees);
  const evidence=[summary&&"Website description",industry&&String(org.industry||"").trim()?"Organization industry":"",industry&&!String(org.industry||"").trim()?"Industry keywords":"",headquarters&&"Organization address",employees&&"Organization employee data",linkedin&&"LinkedIn company link",logo&&"Website organization image"].filter(Boolean);
  const confidence=Math.min(95,50+(summary?10:0)+(String(org["@type"]||"").toLowerCase().includes("organization")?15:0)+(industry?8:0)+(headquarters?5:0)+(linkedin?5:0));
  return {website:finalUrl,domain:safeDomain,summary,industry,headquarters,linkedin_url:linkedin,logo_url:logo,employee_range:employees,source:finalUrl,confidence,evidence};
}

function apolloText(value:unknown,max=1200){return String(value??"").trim().slice(0,max)}
function apolloUrl(value:unknown,base:string){const raw=apolloText(value,1000);if(!raw)return "";return absoluteUrl(/^https?:\/\//i.test(raw)?raw:`https://${raw}`,base)}
function apolloHeadquarters(org:ApolloOrganization){return [org.city,org.state,org.country].map(value=>apolloText(value,120)).filter(Boolean).join(", ")}
function apolloEmployees(org:ApolloOrganization){const raw=org.estimated_num_employees??org.employee_count??org.num_employees??org.employee_range;const count=Number(raw);return Number.isFinite(count)&&count>0?`~${Math.round(count).toLocaleString()}`:apolloText(raw,80)}

export async function enrichCompanyApollo(apiKey:string,input:{name:string;domain?:string;website?:string;linkedinUrl?:string}):Promise<CompanyEnrichmentProposal>{
  const key=apiKey.trim();if(!key)throw new Error("Apollo is not configured. Add APOLLO_API_KEY as a secure Site secret.");
  const domain=normalizedCompanyDomain(input.domain||input.website),website=apolloUrl(input.website,`https://${domain||"example.com"}`),linkedinUrl=apolloUrl(input.linkedinUrl,website||`https://${domain||"example.com"}`);
  if(!domain&&!website&&!linkedinUrl)throw new Error("Add a company website or business-email contact before Apollo enrichment.");
  const url=new URL("https://api.apollo.io/api/v1/organizations/enrich");
  if(domain)url.searchParams.set("domain",domain);if(website)url.searchParams.set("website",website);if(linkedinUrl)url.searchParams.set("linkedin_url",linkedinUrl);if(input.name.trim())url.searchParams.set("name",input.name.trim().slice(0,240));
  const response=await fetch(url,{headers:{accept:"application/json","x-api-key":key}});
  if(response.status===401||response.status===403)throw new Error("Apollo rejected the configured API key or it does not have company-enrichment access.");
  if(response.status===429)throw new Error("Apollo rate limit reached. Try again in a moment.");
  if(!response.ok)throw new Error(`Apollo company enrichment failed (HTTP ${response.status}).`);
  const payload=await response.json() as Record<string,unknown>,org=(payload.organization&&typeof payload.organization==="object"?payload.organization:payload) as ApolloOrganization;
  if(!org||(!apolloText(org.id)&&!apolloText(org.name)))throw new Error("Apollo did not find a matching company.");
  const resolvedDomain=normalizedCompanyDomain(org.primary_domain??org.domain??domain),resolvedWebsite=apolloUrl(org.website_url??org.website??website,`https://${resolvedDomain||domain||"example.com"}`),resolvedLinkedIn=apolloUrl(org.linkedin_url??org.linkedin??linkedinUrl,resolvedWebsite||`https://${resolvedDomain||domain||"example.com"}`),logo=apolloUrl(org.logo_url??org.logo,resolvedWebsite||`https://${resolvedDomain||domain||"example.com"}`),summary=apolloText(org.short_description??org.description,1200),industry=apolloText(org.industry,160),headquarters=apolloHeadquarters(org),employees=apolloEmployees(org);
  const evidence=[industry&&"Apollo industry",headquarters&&"Apollo headquarters",employees&&"Apollo employee estimate",apolloText(org.annual_revenue)&&"Apollo revenue data",apolloText(org.latest_funding_round)&&"Apollo funding data",resolvedLinkedIn&&"Apollo LinkedIn profile",logo&&"Apollo company logo"].filter(Boolean) as string[];
  const confidence=Math.min(98,72+(resolvedDomain?10:0)+(resolvedWebsite?5:0)+(industry?4:0)+(headquarters?3:0)+(employees?3:0));
  return {website:resolvedWebsite,domain:resolvedDomain,summary,industry,headquarters,linkedin_url:resolvedLinkedIn,logo_url:logo,employee_range:employees,source:"Apollo organization enrichment",confidence,evidence};
}
