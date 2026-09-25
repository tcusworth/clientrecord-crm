import { env } from "cloudflare:workers";
import { decryptToken } from "@/lib/microsoft";

type Row={id:string;url:string;events:string;secret_encrypted:string};
const DELIVERY_TIMEOUT_MS=5000;
function hex(buffer:ArrayBuffer){return Array.from(new Uint8Array(buffer)).map(b=>b.toString(16).padStart(2,"0")).join("");}

// Outbound webhooks may only target public HTTPS hostnames on the default port: no credentials, IP literals, or local/internal names.
// DNS that resolves a public name to a private address cannot be caught here, but Workers cannot reach private networks.
export function safeWebhookUrl(value:string){
  let url:URL;try{url=new URL(value)}catch{return null}
  const host=url.hostname.toLowerCase().replace(/\.$/,"");
  if(url.protocol!=="https:"||url.username||url.password||(url.port&&url.port!=="443"))return null;
  if(host.startsWith("[")||/^[\d.]+$/.test(host)||!/^([a-z0-9-]+\.)+[a-z0-9-]*[a-z][a-z0-9-]*$/.test(host))return null;
  if(host==="localhost"||[".localhost",".local",".internal",".home.arpa",".localdomain"].some(suffix=>host.endsWith(suffix)))return null;
  return url;
}

async function deliver(endpoint:Row,event:string,payload:unknown){
  const body=JSON.stringify({id:crypto.randomUUID(),event,createdAt:new Date().toISOString(),data:payload});
  try{
    const url=safeWebhookUrl(endpoint.url);if(!url)throw new Error("Webhook URL is not allowed.");
    const secret=await decryptToken(endpoint.secret_encrypted),key=await crypto.subtle.importKey("raw",new TextEncoder().encode(secret),{name:"HMAC",hash:"SHA-256"},false,["sign"]),signature=hex(await crypto.subtle.sign("HMAC",key,new TextEncoder().encode(body)));
    const response=await fetch(url.toString(),{method:"POST",redirect:"manual",signal:AbortSignal.timeout(DELIVERY_TIMEOUT_MS),headers:{"content-type":"application/json","x-clientrecord-event":event,"x-clientrecord-signature":`sha256=${signature}`},body});
    const delivered=response.status>=200&&response.status<300;
    await env.DB.batch([env.DB.prepare("INSERT INTO webhook_deliveries(endpoint_id,event,status,response_status,error,created_at) VALUES (?,?,?,?,?,datetime('now'))").bind(endpoint.id,event,delivered?"Delivered":"Failed",response.status,response.status>=300&&response.status<400?"Redirects are not followed.":""),env.DB.prepare("UPDATE webhook_endpoints SET last_status=?,last_triggered_at=datetime('now') WHERE id=?").bind(response.status,endpoint.id)]);
  }catch(error){const message=error instanceof Error?error.message:String(error);await env.DB.batch([env.DB.prepare("INSERT INTO webhook_deliveries(endpoint_id,event,status,error,created_at) VALUES (?,?,'Failed',?,datetime('now'))").bind(endpoint.id,event,message.slice(0,1000)),env.DB.prepare("UPDATE webhook_endpoints SET last_status=0,last_triggered_at=datetime('now') WHERE id=?").bind(endpoint.id)]);}
}

// Called inline from every audit(): never throws, and deliveries run in parallel so one slow endpoint costs at most the timeout.
export async function emitWebhook(event:string,payload:unknown){
  try{
    const endpoints=(await env.DB.prepare("SELECT id,url,events,secret_encrypted FROM webhook_endpoints WHERE active=1").all<Row>()).results.filter(row=>{const events=String(row.events).split(",").map(v=>v.trim());return events.includes("*")||events.includes(event)||events.some(value=>value.endsWith(".*")&&event.startsWith(value.slice(0,-1)));});
    const results=await Promise.allSettled(endpoints.map(endpoint=>deliver(endpoint,event,payload)));
    for(const result of results)if(result.status==="rejected")console.error("Webhook delivery could not be recorded",result.reason);
  }catch(error){console.error("Webhook dispatch failed",error);}
}
