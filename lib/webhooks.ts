import { env } from "cloudflare:workers";
import { decryptToken } from "@/lib/microsoft";

type Row={id:string;url:string;events:string;secret_encrypted:string};
function hex(buffer:ArrayBuffer){return Array.from(new Uint8Array(buffer)).map(b=>b.toString(16).padStart(2,"0")).join("");}

export async function emitWebhook(event:string,payload:unknown){
  const endpoints=(await env.DB.prepare("SELECT id,url,events,secret_encrypted FROM webhook_endpoints WHERE active=1").all<Row>()).results.filter(row=>{const events=String(row.events).split(",").map(v=>v.trim());return events.includes("*")||events.includes(event)||events.some(value=>value.endsWith(".*")&&event.startsWith(value.slice(0,-1)));});
  for(const endpoint of endpoints){
    const body=JSON.stringify({id:crypto.randomUUID(),event,createdAt:new Date().toISOString(),data:payload});
    try{
      const secret=await decryptToken(endpoint.secret_encrypted),key=await crypto.subtle.importKey("raw",new TextEncoder().encode(secret),{name:"HMAC",hash:"SHA-256"},false,["sign"]),signature=hex(await crypto.subtle.sign("HMAC",key,new TextEncoder().encode(body)));
      const response=await fetch(endpoint.url,{method:"POST",headers:{"content-type":"application/json","x-clientrecord-event":event,"x-clientrecord-signature":`sha256=${signature}`},body});
      await env.DB.batch([env.DB.prepare("INSERT INTO webhook_deliveries(endpoint_id,event,status,response_status,error,created_at) VALUES (?,?,?,?,'',datetime('now'))").bind(endpoint.id,event,response.ok?"Delivered":"Failed",response.status),env.DB.prepare("UPDATE webhook_endpoints SET last_status=?,last_triggered_at=datetime('now') WHERE id=?").bind(response.status,endpoint.id)]);
    }catch(error){const message=error instanceof Error?error.message:String(error);await env.DB.batch([env.DB.prepare("INSERT INTO webhook_deliveries(endpoint_id,event,status,error,created_at) VALUES (?,?,'Failed',?,datetime('now'))").bind(endpoint.id,event,message.slice(0,1000)),env.DB.prepare("UPDATE webhook_endpoints SET last_status=0,last_triggered_at=datetime('now') WHERE id=?").bind(endpoint.id)]);}
  }
}
