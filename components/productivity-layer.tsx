"use client";

import { useEffect, useMemo, useState } from "react";
import { Building2, Check, CheckSquare, ClipboardPlus, FileText, Keyboard, Mail, MessageSquareText, Plus, RotateCcw, Search, Users } from "lucide-react";
import { Button } from "@/components/ui/button";
import { CommandDialog, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList, CommandSeparator, CommandShortcut } from "@/components/ui/command";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";

type CommandContact={id:number;firstName:string;lastName:string;email:string;company:string;title:string};
type CommandCompany={id:number;name:string;stage:string};
export type CommandDeal={id:number;name:string;company:string;stage:string;owner:string};

type Props={
 onNavigate:(section:string)=>void;onContact:(contact:{id:number})=>void;
 onCreate:(kind:"contact"|"company"|"deal"|"task"|"activity"|"document"|"campaign"|"bulk")=>void;onCommitted?:()=>Promise<void>|void;
};

const actionItems=[
 {kind:"contact",label:"Create contact",hint:"New person record",icon:Users},
 {kind:"company",label:"Create company",hint:"New account record",icon:Building2},
 {kind:"deal",label:"Create deal",hint:"Add to a pipeline",icon:ClipboardPlus},
 {kind:"activity",label:"Log a call or interaction",hint:"Keep the timeline current",icon:MessageSquareText},
 {kind:"task",label:"Add follow-up task",hint:"Create a next action",icon:CheckSquare},
 {kind:"bulk",label:"Bulk update contacts",hint:"Tag or change lifecycle stage",icon:Users},
 {kind:"document",label:"Add client document",hint:"Upload to a client record",icon:FileText},
 {kind:"campaign",label:"Create email",hint:"Start an outreach draft",icon:Mail},
] as const;

type Draft=Record<string,string|number|null>;
type Mentions={contact:CommandContact|null;company:CommandCompany|null;deal:CommandDeal|null};
const noMentions:Mentions={contact:null,company:null,deal:null};
const commandRest=(query:string)=>{const input=query.trim(),verb=input.split(/\s+/)[0]?.toLowerCase()||"";return {verb,rest:input.slice(verb.length).trim()}};
// Records named inside the command text are resolved server-side (GET /api/crm?resource=mentions) instead of scanning every record here.
function parsedCommand(query:string,mentions:Mentions):Draft|null{const input=query.trim(),verb=input.split(/\s+/)[0]?.toLowerCase(),rest=input.slice(verb.length).trim(),money=rest.match(/(?:\$|value\s+)([\d,.]+)/i),close=rest.match(/(?:close|closing)\s+(\d{4}-\d{2}-\d{2})/i),email=rest.match(/[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}/)?.[0]||"";if(verb==="contact"&&rest){const company=rest.match(/\s+(?:at|@)\s+(.+?)(?=\s+[\w.+-]+@[\w.-]+|$)/i)?.[1]||"",name=rest.replace(email,"").replace(/\s+(?:at|@)\s+.+$/i,"").trim();return {kind:"contact",name,email,company,title:"",phone:"",location:"",stage:"Lead"}}if(verb==="deal"&&rest){const company=mentions.company,name=rest.replace(money?.[0]||"","").replace(close?.[0]||"","").trim();return {kind:"deal",name,companyId:company?.id||null,company:company?.name||"",value:money?.[1]?.replaceAll(",","")||0,closeDate:close?.[1]||"",nextStep:"Qualify opportunity"}}if((verb==="task"||verb==="activity")&&rest){const contact=mentions.contact,deal=mentions.deal;let detail=rest;if(contact)detail=detail.replace(new RegExp(`${contact.firstName}\\s+${contact.lastName}`,"i"),"");if(deal)detail=detail.replace(deal.name,"");detail=detail.trim();return verb==="task"?{kind:"task",title:detail,contactId:contact?.id||null,dealId:deal?.id||null,dueDate:new Date(Date.now()+86400000).toISOString().slice(0,10)}:{kind:"activity",note:detail,contactId:contact?.id||null,dealId:deal?.id||null,type:"Note",outcome:""}}return null}

export function ProductivityLayer({onNavigate,onContact,onCreate,onCommitted}:Props){
 const [open,setOpen]=useState(false),[quickOpen,setQuickOpen]=useState(false),[query,setQuery]=useState(""),[draft,setDraft]=useState<Draft|null>(null),[busy,setBusy]=useState(false),[error,setError]=useState(""),[recent,setRecent]=useState<Array<{kind:"section"|"contact";id:string;label:string}>>(()=>{if(typeof window==="undefined")return[];try{return JSON.parse(localStorage.getItem("clientrecord:recent")||"[]")}catch{return[]}});
 const shortcut=typeof navigator!=="undefined"&&/mac/i.test(navigator.platform)?"⌘K":"Ctrl K";
 useEffect(()=>{const onKey=(event:KeyboardEvent)=>{const target=event.target as HTMLElement|null,typing=Boolean(target?.closest("input,textarea,select,[contenteditable='true']"));if((event.metaKey||event.ctrlKey)&&event.key.toLowerCase()==="k"){event.preventDefault();setOpen(value=>!value);return}if(event.key==="Escape"){setOpen(false);setQuickOpen(false);return}if(typing)return;if(event.shiftKey&&event.key.toLowerCase()==="t"){event.preventDefault();onNavigate("today");return}if(event.shiftKey&&event.key.toLowerCase()==="a"){event.preventDefault();onCreate("activity");return}if(event.key.toLowerCase()==="n"){event.preventDefault();setQuickOpen(value=>!value)}};window.addEventListener("keydown",onKey);return()=>window.removeEventListener("keydown",onKey)},[onCreate,onNavigate]);
 const [results,setResults]=useState<{contacts:CommandContact[];companies:CommandCompany[];deals:CommandDeal[]}>({contacts:[],companies:[],deals:[]}),[mentions,setMentions]=useState<Mentions&{text:string}>({...noMentions,text:""});
 useEffect(()=>{const q=query.trim();if(!open||q.length<2)return;let alive=true;const timer=window.setTimeout(()=>{void fetch(`/api/crm?${new URLSearchParams({resource:"search",q,limit:"8"})}`,{cache:"no-store"}).then(response=>response.ok?response.json() as Promise<{contacts?:CommandContact[];companies?:CommandCompany[];deals?:CommandDeal[]}>:null).then(body=>{if(alive&&body)setResults({contacts:body.contacts||[],companies:body.companies||[],deals:body.deals||[]})}).catch(()=>{})},180);return()=>{alive=false;window.clearTimeout(timer)}},[query,open]);
 useEffect(()=>{const {verb,rest}=commandRest(query);if(!open||!rest||!["deal","task","activity"].includes(verb))return;let alive=true;const timer=window.setTimeout(()=>{void fetch(`/api/crm?${new URLSearchParams({resource:"mentions",text:rest})}`,{cache:"no-store"}).then(response=>response.ok?response.json():null).then(body=>{if(alive&&body)setMentions({...noMentions,...body,text:rest})}).catch(()=>{})},180);return()=>{alive=false;window.clearTimeout(timer)}},[query,open]);
 const visibleResults=query.trim().length<2?{contacts:[],companies:[],deals:[]}:results;
 const commandDraft=useMemo(()=>parsedCommand(query,mentions.text===commandRest(query).rest?mentions:noMentions),[query,mentions]);
 const remember=(item:{kind:"section"|"contact";id:string;label:string})=>{setRecent(current=>{const next=[item,...current.filter(value=>!(value.kind===item.kind&&value.id===item.id))].slice(0,6);localStorage.setItem("clientrecord:recent",JSON.stringify(next));return next})};
 const run=(kind:typeof actionItems[number]["kind"])=>{setOpen(false);setQuickOpen(false);onCreate(kind)};
 const go=(section:string,label=section)=>{setOpen(false);remember({kind:"section",id:section,label});onNavigate(section)};
 async function commitDraft(){if(!draft)return;setBusy(true);setError("");try{const response=await fetch("/api/quick-capture",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({action:"commitDraft",draft})}),body=await response.json() as{error?:string;undoToken?:string};if(!response.ok)throw new Error(body.error||"Draft could not be saved.");window.dispatchEvent(new CustomEvent("crm:undoable",{detail:{token:body.undoToken,label:`${String(draft.kind)} created`}}));setDraft(null);setQuery("");await onCommitted?.()}catch(reason){setError(reason instanceof Error?reason.message:"Draft could not be saved.")}finally{setBusy(false)}}
 return <><DraftRecovery/><UndoCenter/>
  <button onClick={()=>setOpen(true)} className="hidden h-11 min-w-0 items-center gap-3 rounded-lg border bg-[#f7f8fa] px-3 text-left text-sm text-slate-500 hover:border-[#3968ff] md:flex" aria-label="Open command bar"><Search size={18}/><span className="flex-1 truncate">Search records or run a command</span><kbd className="rounded border bg-white px-1.5 py-0.5 text-[11px] text-slate-500">{shortcut}</kbd></button>
  <Button variant="outline" className="h-11 md:hidden" onClick={()=>setOpen(true)} aria-label="Search and commands"><Search size={18}/></Button>
  <div className="fixed bottom-5 right-5 z-40 hidden lg:block">
   <DropdownMenu open={quickOpen} onOpenChange={setQuickOpen}><DropdownMenuTrigger asChild><Button size="icon" className="h-14 w-14 rounded-full bg-[#3968ff] shadow-lg" aria-label="Open quick create menu" title="Quick create"><Plus className={quickOpen?"rotate-45 transition":"transition"} size={24}/></Button></DropdownMenuTrigger><DropdownMenuContent side="top" align="end" sideOffset={10} className="w-72 p-2"><DropdownMenuLabel>Quick create</DropdownMenuLabel><DropdownMenuSeparator/>{actionItems.map(item=>{const Icon=item.icon;return <DropdownMenuItem key={item.kind} className="items-start gap-3 p-3" onSelect={()=>run(item.kind)}><span className="grid h-8 w-8 shrink-0 place-items-center rounded-md bg-blue-50 text-[#3968ff]"><Icon size={16}/></span><span><strong className="block font-medium">{item.label}</strong><span className="mt-0.5 block text-xs text-slate-500">{item.hint}</span></span></DropdownMenuItem>})}</DropdownMenuContent></DropdownMenu>
  </div>
  <CommandDialog open={open} onOpenChange={setOpen} title="ClientRecord command bar" description="Find records, navigate, or run a CRM action." className="w-[calc(100vw-2rem)] max-w-2xl">
   <CommandInput value={query} onValueChange={setQuery} placeholder="Try: deal Acme renewal $25000 close 2026-12-15" />
   <CommandList><CommandEmpty>No matching records or commands.</CommandEmpty>
    {commandDraft&&<CommandGroup heading="Parsed draft"><CommandItem value={`Create ${query}`} onSelect={()=>{setOpen(false);setDraft(commandDraft)}}><Check/><span className="min-w-0 flex-1 truncate">Review and create: {query}</span><CommandShortcut>Enter</CommandShortcut></CommandItem></CommandGroup>}
    <CommandGroup heading="Create and log">{actionItems.map(item=>{const Icon=item.icon;return <CommandItem key={item.kind} value={`${item.label} ${item.hint}`} onSelect={()=>run(item.kind)}><Icon/><span>{item.label}</span><span className="ml-auto text-xs text-slate-500">{item.hint}</span></CommandItem>})}</CommandGroup>
    <CommandSeparator/>
    {recent.length>0&&<CommandGroup heading="Recent">{recent.map(item=><CommandItem key={`${item.kind}:${item.id}`} value={`Recent ${item.label}`} onSelect={()=>{if(item.kind==="contact"){setOpen(false);onContact({id:Number(item.id)})}else go(item.id,item.label)}}><RotateCcw/><span>{item.label}</span></CommandItem>)}</CommandGroup>}
    <CommandGroup heading="Saved views">{[["deals","At risk"],["deals","Closing this month"],["contacts","Needs follow-up"],["contacts","Quiet 30+ days"]].map(([section,label])=><CommandItem key={label} value={`Saved view ${label}`} onSelect={()=>{localStorage.setItem(`clientrecord:${section}-saved-view`,label);go(section,label)}}><FileText/><span>{label}</span><span className="ml-auto text-xs text-slate-500">{section}</span></CommandItem>)}</CommandGroup>
    <CommandGroup heading="Go to">{[["today","Today"],["dashboard","Dashboard"],["contacts","Contacts"],["companies","Companies"],["deals","Pipelines"],["documents","Documents"],["settings","Settings"]].map(([id,label])=><CommandItem key={id} value={`Go to ${label}`} onSelect={()=>go(id,label)}><Keyboard/><span>{label}</span>{label==="Today"&&<CommandShortcut>G T</CommandShortcut>}</CommandItem>)}</CommandGroup>
    <CommandSeparator/>
    <CommandGroup heading="Contacts">{visibleResults.contacts.map(contact=><CommandItem key={contact.id} value={`${contact.firstName} ${contact.lastName} ${contact.email} ${contact.company} ${contact.title}`} onSelect={()=>{setOpen(false);remember({kind:"contact",id:String(contact.id),label:`${contact.firstName} ${contact.lastName}`});onContact(contact)}}><Users/><span className="min-w-0 flex-1 truncate"><strong>{contact.firstName} {contact.lastName}</strong><span className="ml-2 text-xs text-slate-500">{contact.company||contact.email}</span></span></CommandItem>)}</CommandGroup>
    <CommandGroup heading="Companies">{visibleResults.companies.map(company=><CommandItem key={company.id} value={`${company.name} ${company.stage}`} onSelect={()=>go("companies",company.name)}><Building2/><span>{company.name}</span><span className="ml-auto text-xs text-slate-500">{company.stage}</span></CommandItem>)}</CommandGroup>
    <CommandGroup heading="Deals">{visibleResults.deals.map(deal=><CommandItem key={deal.id} value={`${deal.name} ${deal.company} ${deal.stage} ${deal.owner}`} onSelect={()=>go("deals",deal.name)}><ClipboardPlus/><span className="min-w-0 flex-1 truncate">{deal.name}<span className="ml-2 text-xs text-slate-500">{deal.company||deal.stage}</span></span></CommandItem>)}</CommandGroup>
   </CommandList>
 </CommandDialog>
 <Dialog open={Boolean(draft)} onOpenChange={next=>{if(!next){setDraft(null);setError("")}}}><DialogContent><DialogHeader><DialogTitle>Review {String(draft?.kind||"")} draft</DialogTitle><DialogDescription>Confirm or edit the parsed values. Nothing is saved until you create it.</DialogDescription></DialogHeader>{draft&&<div className="grid gap-3">{Object.entries(draft).filter(([key])=>!(["kind","contactId","dealId","companyId"].includes(key))).map(([key,value])=><label key={key} className="grid gap-1 text-sm font-medium"><span className="capitalize">{key.replace(/([A-Z])/g," $1")}</span>{key==="note"||key==="nextStep"?<Textarea value={String(value??"")} onChange={event=>setDraft(current=>({...current!,[key]:event.target.value}))}/>:<Input type={key.toLowerCase().includes("date")?"date":key==="value"?"number":"text"} value={String(value??"")} onChange={event=>setDraft(current=>({...current!,[key]:event.target.value}))}/>}</label>)}{error&&<p className="rounded-lg bg-red-50 p-3 text-sm text-red-700">{error}</p>}<Button disabled={busy} onClick={()=>void commitDraft()}><Check size={16}/>{busy?"Creating…":"Create reviewed draft"}</Button></div>}</DialogContent></Dialog>
 </>;
}

function DraftRecovery(){
 const [status,setStatus]=useState("");
 useEffect(()=>{
	  const key=(form:HTMLFormElement)=>`clientrecord:draft:${location.pathname}:${form.getAttribute("data-draft-key")||Array.from(form.querySelectorAll("[name]")).map(element=>(element as HTMLInputElement).name).slice(0,8).join("|")}`;
  let timer=0;const write=(form:HTMLFormElement)=>{const values:Array<[string,string|boolean]>=[];for(const element of Array.from(form.elements)){if(!(element instanceof HTMLInputElement||element instanceof HTMLTextAreaElement||element instanceof HTMLSelectElement)||!element.name||element.type==="file"||element.hasAttribute("data-no-draft"))continue;values.push([element.name,element instanceof HTMLInputElement&&element.type==="checkbox"?element.checked:element.value])}if(values.length){sessionStorage.setItem(key(form),JSON.stringify(values));setStatus("Draft saved on this device");window.clearTimeout(timer);timer=window.setTimeout(()=>setStatus(""),1800)}};
  const restore=(form:HTMLFormElement)=>{if(form.dataset.draftRestored)return;form.dataset.draftRestored="true";let values:Array<[string,string|boolean]> = [];try{values=JSON.parse(sessionStorage.getItem(key(form))||"[]")}catch{}for(const [name,value] of values){const element=form.elements.namedItem(name);if(!(element instanceof HTMLInputElement||element instanceof HTMLTextAreaElement||element instanceof HTMLSelectElement)||element.hasAttribute("data-no-draft"))continue;if(element instanceof HTMLInputElement&&element.type==="checkbox"){if(!element.checked)element.checked=Boolean(value)}else if(!element.value)element.value=String(value)}};
  const closest=(target:EventTarget|null)=>target instanceof Element?target.closest("form"):null;
  const save=(event:Event)=>{const form=closest(event.target);if(form)write(form)};
  const recover=(event:Event)=>{const form=closest(event.target);if(form)restore(form)};
  const clear=(event:Event)=>{const form=event.target instanceof HTMLFormElement?event.target:null;if(form)sessionStorage.removeItem(key(form))};
  document.addEventListener("input",save,true);document.addEventListener("change",save,true);document.addEventListener("focusin",recover,true);document.addEventListener("submit",clear,true);
  return()=>{window.clearTimeout(timer);document.removeEventListener("input",save,true);document.removeEventListener("change",save,true);document.removeEventListener("focusin",recover,true);document.removeEventListener("submit",clear,true)};
 },[]);
 return status?<div className="fixed bottom-5 left-1/2 z-[70] -translate-x-1/2 rounded-lg border bg-white px-3 py-2 text-xs text-slate-600 shadow-lg"><Check className="mr-1 inline" size={13}/>{status}</div>:null;
}

function UndoCenter(){const[item,setItem]=useState<{token:string;label:string}|null>(null),[busy,setBusy]=useState(false);useEffect(()=>{const show=(event:Event)=>{const detail=(event as CustomEvent<{token:string;label:string}>).detail;if(!detail?.token)return;setItem(detail);window.setTimeout(()=>setItem(current=>current?.token===detail.token?null:current),15000)};window.addEventListener("crm:undoable",show);return()=>window.removeEventListener("crm:undoable",show)},[]);if(!item)return null;return <div className="fixed bottom-5 left-1/2 z-[80] flex -translate-x-1/2 items-center gap-3 rounded-lg bg-slate-950 px-4 py-3 text-sm text-white shadow-xl"><Check size={16}/><span>{item.label}</span><button disabled={busy} className="flex items-center gap-1 font-semibold text-blue-300" onClick={async()=>{setBusy(true);const response=await fetch("/api/quick-capture",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({action:"undo",token:item.token})});setBusy(false);if(response.ok)setItem(null)}}><RotateCcw size={14}/>Undo</button></div>}
