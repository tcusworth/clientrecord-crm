"use client";

import { useEffect, useMemo, useState } from "react";
import { Building2, CheckSquare, ClipboardPlus, FileText, Keyboard, Mail, MessageSquareText, Plus, Search, Settings, Users } from "lucide-react";
import { Button } from "@/components/ui/button";
import { CommandDialog, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList, CommandSeparator, CommandShortcut } from "@/components/ui/command";

export type CommandContact={id:number;firstName:string;lastName:string;email:string;company:string;title:string};
export type CommandCompany={id:number;name:string;stage:string};
export type CommandDeal={id:number;name:string;company:string;stage:string;owner:string};

type Props={
 contacts:CommandContact[];companies:CommandCompany[];deals:CommandDeal[];
 onNavigate:(section:string)=>void;onContact:(contact:CommandContact)=>void;
 onCreate:(kind:"contact"|"company"|"deal"|"task"|"activity"|"document"|"campaign"|"bulk")=>void;
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

export function ProductivityLayer({contacts,companies,deals,onNavigate,onContact,onCreate}:Props){
 const [open,setOpen]=useState(false),[quickOpen,setQuickOpen]=useState(false);
 const shortcut=typeof navigator!=="undefined"&&/mac/i.test(navigator.platform)?"⌘K":"Ctrl K";
 useEffect(()=>{const onKey=(event:KeyboardEvent)=>{const target=event.target as HTMLElement|null,typing=Boolean(target?.closest("input,textarea,select,[contenteditable='true']"));if((event.metaKey||event.ctrlKey)&&event.key.toLowerCase()==="k"){event.preventDefault();setOpen(value=>!value);return}if(event.key==="Escape"){setOpen(false);setQuickOpen(false);return}if(typing)return;if(event.shiftKey&&event.key.toLowerCase()==="t"){event.preventDefault();onNavigate("today");return}if(event.shiftKey&&event.key.toLowerCase()==="a"){event.preventDefault();onCreate("activity");return}if(event.key.toLowerCase()==="n"){event.preventDefault();setQuickOpen(value=>!value)}};window.addEventListener("keydown",onKey);return()=>window.removeEventListener("keydown",onKey)},[onCreate,onNavigate]);
 const topContacts=useMemo(()=>contacts.slice(0,80),[contacts]);
 const run=(kind:typeof actionItems[number]["kind"])=>{setOpen(false);setQuickOpen(false);onCreate(kind)};
 const go=(section:string)=>{setOpen(false);onNavigate(section)};
 return <><DraftRecovery/>
  <button onClick={()=>setOpen(true)} className="hidden h-11 min-w-0 items-center gap-3 rounded-lg border bg-[#f7f8fa] px-3 text-left text-sm text-slate-500 hover:border-[#3968ff] md:flex" aria-label="Open command bar"><Search size={18}/><span className="flex-1 truncate">Search records or run a command</span><kbd className="rounded border bg-white px-1.5 py-0.5 text-[11px] text-slate-500">{shortcut}</kbd></button>
  <Button variant="outline" className="h-11 md:hidden" onClick={()=>setOpen(true)} aria-label="Search and commands"><Search size={18}/></Button>
  <div className="fixed bottom-5 right-5 z-40 flex flex-col items-end gap-2">
   {quickOpen&&<div className="w-64 overflow-hidden rounded-2xl border bg-white p-2 shadow-2xl">{actionItems.map(item=>{const Icon=item.icon;return <button key={item.kind} onClick={()=>run(item.kind)} className="flex w-full items-center gap-3 rounded-xl px-3 py-2.5 text-left hover:bg-slate-50"><span className="grid h-8 w-8 place-items-center rounded-lg bg-blue-50 text-[#3968ff]"><Icon size={16}/></span><span><strong className="block text-sm">{item.label}</strong><span className="block text-xs text-slate-500">{item.hint}</span></span></button>})}</div>}
   <Button size="icon" className="h-14 w-14 rounded-full bg-[#3968ff] shadow-lg" onClick={()=>setQuickOpen(value=>!value)} aria-label="Quick add"><Plus className={quickOpen?"rotate-45 transition":"transition"} size={24}/></Button>
  </div>
  <div className="fixed inset-x-0 bottom-0 z-30 grid grid-cols-4 border-t bg-white p-2 shadow-[0_-6px_20px_rgba(15,23,42,.08)] lg:hidden">
   <button onClick={()=>go("today")} className="grid place-items-center gap-1 rounded-lg py-2 text-xs text-slate-600"><CheckSquare size={18}/>Today</button><button onClick={()=>setOpen(true)} className="grid place-items-center gap-1 rounded-lg py-2 text-xs text-slate-600"><Search size={18}/>Find</button><button onClick={()=>run("activity")} className="grid place-items-center gap-1 rounded-lg py-2 text-xs text-slate-600"><MessageSquareText size={18}/>Log</button><button onClick={()=>setQuickOpen(true)} className="grid place-items-center gap-1 rounded-lg py-2 text-xs text-slate-600"><Plus size={18}/>Add</button>
  </div>
  <CommandDialog open={open} onOpenChange={setOpen} title="ClientRecord command bar" description="Find records, navigate, or run a CRM action." className="w-[calc(100vw-2rem)] max-w-2xl">
   <CommandInput placeholder="Search people, companies, deals, or commands…" />
   <CommandList><CommandEmpty>No matching records or commands.</CommandEmpty>
    <CommandGroup heading="Create and log">{actionItems.map(item=>{const Icon=item.icon;return <CommandItem key={item.kind} value={`${item.label} ${item.hint}`} onSelect={()=>run(item.kind)}><Icon/><span>{item.label}</span><span className="ml-auto text-xs text-slate-500">{item.hint}</span></CommandItem>})}</CommandGroup>
    <CommandSeparator/>
    <CommandGroup heading="Go to">{[["today","Today"],["dashboard","Dashboard"],["contacts","Contacts"],["companies","Companies"],["deals","Pipelines"],["documents","Documents"],["settings","Settings"]].map(([id,label])=><CommandItem key={id} value={`Go to ${label}`} onSelect={()=>go(id)}><Keyboard/><span>{label}</span>{label==="Today"&&<CommandShortcut>G T</CommandShortcut>}</CommandItem>)}</CommandGroup>
    <CommandSeparator/>
    <CommandGroup heading="Contacts">{topContacts.map(contact=><CommandItem key={contact.id} value={`${contact.firstName} ${contact.lastName} ${contact.email} ${contact.company} ${contact.title}`} onSelect={()=>{setOpen(false);onContact(contact)}}><Users/><span className="min-w-0 flex-1 truncate"><strong>{contact.firstName} {contact.lastName}</strong><span className="ml-2 text-xs text-slate-500">{contact.company||contact.email}</span></span></CommandItem>)}</CommandGroup>
    <CommandGroup heading="Companies">{companies.slice(0,50).map(company=><CommandItem key={company.id} value={`${company.name} ${company.stage}`} onSelect={()=>go("companies")}><Building2/><span>{company.name}</span><span className="ml-auto text-xs text-slate-500">{company.stage}</span></CommandItem>)}</CommandGroup>
    <CommandGroup heading="Deals">{deals.slice(0,50).map(deal=><CommandItem key={deal.id} value={`${deal.name} ${deal.company} ${deal.stage} ${deal.owner}`} onSelect={()=>go("deals")}><ClipboardPlus/><span className="min-w-0 flex-1 truncate">{deal.name}<span className="ml-2 text-xs text-slate-500">{deal.company||deal.stage}</span></span></CommandItem>)}</CommandGroup>
   </CommandList>
 </CommandDialog>
 </>;
}

function DraftRecovery(){
 useEffect(()=>{
  const key=(form:HTMLFormElement)=>`clientrecord:draft:${location.pathname}:${form.getAttribute("data-draft-key")||Array.from(form.elements).filter((element):element is HTMLInputElement|HTMLTextAreaElement|HTMLSelectElement=>Boolean((element as HTMLInputElement).name)).map(element=>element.name).slice(0,8).join("|")}`;
  const write=(form:HTMLFormElement)=>{const values:Array<[string,string|boolean]>=[];for(const element of Array.from(form.elements)){if(!(element instanceof HTMLInputElement||element instanceof HTMLTextAreaElement||element instanceof HTMLSelectElement)||!element.name||element.type==="file")continue;values.push([element.name,element instanceof HTMLInputElement&&element.type==="checkbox"?element.checked:element.value])}if(values.length)sessionStorage.setItem(key(form),JSON.stringify(values))};
  const restore=(form:HTMLFormElement)=>{if(form.dataset.draftRestored)return;form.dataset.draftRestored="true";let values:Array<[string,string|boolean]> = [];try{values=JSON.parse(sessionStorage.getItem(key(form))||"[]")}catch{}for(const [name,value] of values){const element=form.elements.namedItem(name);if(!(element instanceof HTMLInputElement||element instanceof HTMLTextAreaElement||element instanceof HTMLSelectElement))continue;if(element instanceof HTMLInputElement&&element.type==="checkbox"){if(!element.checked)element.checked=Boolean(value)}else if(!element.value)element.value=String(value)}};
  const closest=(target:EventTarget|null)=>target instanceof Element?target.closest("form"):null;
  const save=(event:Event)=>{const form=closest(event.target);if(form)write(form)};
  const recover=(event:Event)=>{const form=closest(event.target);if(form)restore(form)};
  const clear=(event:Event)=>{const form=event.target instanceof HTMLFormElement?event.target:null;if(form)sessionStorage.removeItem(key(form))};
  document.addEventListener("input",save,true);document.addEventListener("change",save,true);document.addEventListener("focusin",recover,true);document.addEventListener("submit",clear,true);
  return()=>{document.removeEventListener("input",save,true);document.removeEventListener("change",save,true);document.removeEventListener("focusin",recover,true);document.removeEventListener("submit",clear,true)};
 },[]);
 return null;
}
