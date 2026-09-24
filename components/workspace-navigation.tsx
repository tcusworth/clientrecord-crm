"use client";

import { useEffect, useState } from "react";
import { Briefcase, Camera, CheckSquare, FileText, Heart, Mail, Mic, Plus, RadioTower, Star, Wifi, WifiOff } from "lucide-react";

const destinations=[{id:"today",label:"Today"},{id:"deals",label:"Deals"},{id:"inbox",label:"Inbox"},{id:"communication-review",label:"Communication review"},{id:"service",label:"Service cases"},{id:"partners",label:"Partners"},{id:"documents",label:"Documents"},{id:"field",label:"Field capture"}];
const icons:Record<string,typeof Star>={today:CheckSquare,deals:Briefcase,inbox:Mail,service:Heart,documents:FileText,field:RadioTower};

export function WorkspaceFavorites({active,onNavigate}:{active:string;onNavigate:(id:string)=>void}){
 const[favorites,setFavorites]=useState<string[]>(()=>{if(typeof window==="undefined")return["today","deals","inbox"];try{const saved=JSON.parse(localStorage.getItem("clientrecord:favorites")||"[]") as string[];return saved.length?saved:["today","deals","inbox"]}catch{return["today","deals","inbox"]}}),[editing,setEditing]=useState(false);
 const update=(items:string[])=>{setFavorites(items);localStorage.setItem("clientrecord:favorites",JSON.stringify(items))};
 return <section className="mb-2 border-b border-white/10 pb-2"><div className="flex h-8 items-center justify-between px-3 text-[11px] font-semibold uppercase text-slate-400"><span>Favorites</span><button className="rounded p-1 hover:bg-white/10" title="Configure favorites" onClick={()=>setEditing(value=>!value)}><Star size={13}/></button></div>{favorites.map(id=>{const item=destinations.find(value=>value.id===id);if(!item)return null;const Icon=icons[id]||Star;return <button key={id} onClick={()=>onNavigate(id)} className={`mb-0.5 flex w-full items-center gap-3 rounded-md px-3 py-2 text-left text-sm ${active===id?"bg-white/12 text-white":"text-slate-300 hover:bg-white/7"}`}><Icon size={16}/><span className="truncate">{item.label}</span></button>})}{editing&&<div className="mx-2 mt-2 rounded-md border border-white/10 bg-white/5 p-2">{destinations.map(item=><label key={item.id} className="flex items-center gap-2 py-1.5 text-xs text-slate-300"><input type="checkbox" checked={favorites.includes(item.id)} onChange={event=>update(event.target.checked?[...favorites,item.id]:favorites.filter(id=>id!==item.id))}/>{item.label}</label>)}</div>}</section>;
}

export function MobileFieldBar(){
 const[online,setOnline]=useState(()=>typeof navigator==="undefined"?true:navigator.onLine);
 useEffect(()=>{const update=()=>setOnline(navigator.onLine);window.addEventListener("online",update);window.addEventListener("offline",update);return()=>{window.removeEventListener("online",update);window.removeEventListener("offline",update)}},[]);
 const create=(kind:string)=>window.dispatchEvent(new CustomEvent("crm:quick-create",{detail:kind}));
 const navigate=(section:string)=>window.dispatchEvent(new CustomEvent("crm:navigate",{detail:section}));
 return <div className="fixed inset-x-0 bottom-0 z-30 border-t bg-white/95 pb-[env(safe-area-inset-bottom)] backdrop-blur lg:hidden"><div className="grid h-16 grid-cols-6"><button onClick={()=>create("activity")} className="mobile-action"><Mic size={19}/><span>Note</span></button><button onClick={()=>navigate("field")} className="mobile-action"><Camera size={19}/><span>Scan</span></button><button onClick={()=>create("task")} className="mobile-action"><CheckSquare size={19}/><span>Task</span></button><button onClick={()=>navigate("field")} className="mobile-action"><RadioTower size={19}/><span>Check-in</span></button><button onClick={()=>create("contact")} className="mobile-action"><Plus size={19}/><span>Contact</span></button><div className={`mobile-action ${online?"text-emerald-700":"text-amber-700"}`}>{online?<Wifi size={19}/>:<WifiOff size={19}/>}<span>{online?"Online":"Queued"}</span></div></div></div>;
}
