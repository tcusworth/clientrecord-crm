export type Stage = { key:string; name:string; probability:number; kind:"Open"|"Won"|"Lost" };
export type Pipeline = { id:string; name:string; stages:Stage[] };
export const defaultPipeline:Pipeline = {id:"default",name:"New business",stages:[
  {key:"Qualified",name:"Qualified",probability:25,kind:"Open"},
  {key:"Discovery",name:"Discovery",probability:40,kind:"Open"},
  {key:"Proposal",name:"Proposal",probability:60,kind:"Open"},
  {key:"Negotiation",name:"Negotiation",probability:80,kind:"Open"},
  {key:"Won",name:"Won",probability:100,kind:"Won"},
  {key:"Lost",name:"Lost",probability:0,kind:"Lost"},
]};
export const signalPoints:Record<string,number> = {"Strategic initiative":20,"Engaged conversation":20,"Budget confirmed":30,"Demo request":40,"RFP / buying process":60,"Project paused":-40,"General news":0};
export const relationshipRoles = ["Decision-maker","Champion","Blocker","Influencer","Colleague"];
export function qualification(fit:number,intent:number) {return intent>=60&&fit>=50?"Hot":intent>=20?"Lukewarm":"Cold";}
export function validateStages(value:unknown):Stage[] {
  if(!Array.isArray(value)||value.length<3||value.length>16)throw new Error("Use 3–16 stages, including open, won and lost outcomes.");
  const rows=value.map(v=>({key:String(v.key||"").trim(),name:String(v.name||"").trim(),probability:Number(v.probability),kind:v.kind})) as Stage[];
  if(rows.some(v=>!v.key||!v.name||v.name.length>60||!["Open","Won","Lost"].includes(v.kind)||!Number.isFinite(v.probability)||v.probability<0||v.probability>100))throw new Error("Every stage needs a name, stable key, valid outcome and probability from 0 to 100.");
  if(new Set(rows.map(v=>v.key)).size!==rows.length||new Set(rows.map(v=>v.name.toLowerCase())).size!==rows.length)throw new Error("Stage keys and names must be unique.");
  if(!["Open","Won","Lost"].every(k=>rows.some(v=>v.kind===k)))throw new Error("Include open, won and lost stages.");
  return rows.map(v=>({...v,probability:v.kind==="Won"?100:v.kind==="Lost"?0:v.probability}));
}
