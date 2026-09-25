"use client";

// Server-backed typeahead for choosing a contact, company or deal. Replaces <select> lists that needed every record in the
// browser: it asks GET /api/crm?resource=search for a small page of matches and submits the chosen id through a hidden input.
import { useEffect, useId, useRef, useState } from "react";
import { X } from "lucide-react";
import type { Row } from "@/lib/crm-types";

export type RecordKind="contact"|"company"|"deal";
export type PickedRecord={id:number;label:string;detail:string;row:Row};
const KEYS={contact:"contacts",company:"companies",deal:"deals"} as const;
const str=(value:unknown)=>value==null?"":String(value);
export function toPicked(kind:RecordKind,row:Row):PickedRecord{const label=kind==="contact"?`${str(row.firstName)} ${str(row.lastName)}`.trim()||str(row.name)||str(row.email):str(row.name);return {id:Number(row.id),label,detail:kind==="contact"?str(row.company)||str(row.email):kind==="company"?str(row.domain)||str(row.stage):str(row.company)||str(row.stage),row}}
/** Small server-side search; `ids` resolves labels of already-selected records. */
export async function findRecords(kind:RecordKind,{q="",ids=[],limit=8,companyId}:{q?:string;ids?:Array<number|string>;limit?:number;companyId?:number|string}={}){const params=new URLSearchParams({resource:"search",types:kind,q,limit:String(limit)});const idList=ids.map(Number).filter(id=>id>0);if(idList.length)params.set("ids",idList.join(","));if(Number(companyId)>0)params.set("companyId",String(companyId));const response=await fetch(`/api/crm?${params}`,{cache:"no-store"});if(!response.ok)return [];const body=await response.json() as Record<string,Row[]|undefined>;return (body[KEYS[kind]]||[]).map(row=>toPicked(kind,row))}

type Props={kind:RecordKind;name?:string;value?:string;defaultValue?:string|number|null;defaultLabel?:string;onChange?:(id:string,record:PickedRecord|null)=>void;required?:boolean;disabled?:boolean;placeholder?:string;companyId?:number|string;className?:string;ariaLabel?:string};
export function RecordPicker({kind,name,value,defaultValue,defaultLabel="",onChange,required,disabled,placeholder,companyId,className="h-10 w-full min-w-0 rounded-md border bg-white px-3 text-sm",ariaLabel}:Props){
 const controlled=value!==undefined,[own,setOwn]=useState(str(defaultValue??"")),selectedId=controlled?str(value):own;
 const [labels,setLabels]=useState<Record<string,string>>(()=>selectedId&&defaultLabel?{[selectedId]:defaultLabel}:{}),[query,setQuery]=useState(""),[open,setOpen]=useState(false),[results,setResults]=useState<PickedRecord[]>([]),[active,setActive]=useState(0),[loading,setLoading]=useState(false);
 const input=useRef<HTMLInputElement>(null),listId=useId(),label=selectedId?labels[selectedId]??"":"";
 useEffect(()=>{if(!selectedId||labels[selectedId]!==undefined)return;let alive=true;void findRecords(kind,{ids:[selectedId],limit:1}).then(found=>{if(alive)setLabels(current=>({...current,[selectedId]:found[0]?.label||`#${selectedId}`}))});return()=>{alive=false}},[kind,selectedId,labels]);
 useEffect(()=>{if(!open)return;let alive=true;const timer=window.setTimeout(()=>{setLoading(true);void findRecords(kind,{q:query.trim(),companyId}).then(found=>{if(alive){setResults(found);setActive(0)}}).finally(()=>{if(alive)setLoading(false)})},query?200:0);return()=>{alive=false;window.clearTimeout(timer)}},[kind,query,open,companyId]);
 useEffect(()=>{input.current?.setCustomValidity(required&&!selectedId?"Choose a record from the list.":"")},[required,selectedId]);
 const choose=(record:PickedRecord|null)=>{const id=record?String(record.id):"";if(record)setLabels(current=>({...current,[id]:record.label}));if(!controlled)setOwn(id);setQuery("");setOpen(false);onChange?.(id,record)};
 const onKey=(event:React.KeyboardEvent<HTMLInputElement>)=>{if(event.key==="ArrowDown"){event.preventDefault();setOpen(true);setActive(index=>Math.min(results.length-1,index+1))}else if(event.key==="ArrowUp"){event.preventDefault();setActive(index=>Math.max(0,index-1))}else if(event.key==="Enter"&&open&&results[active]){event.preventDefault();choose(results[active])}else if(event.key==="Escape"&&open){event.stopPropagation();setOpen(false);setQuery("")}};
 return <div className="relative min-w-0">
  {name&&<input type="hidden" name={name} value={selectedId} data-no-draft/>}
  <input ref={input} role="combobox" aria-expanded={open} aria-controls={listId} aria-autocomplete="list" aria-label={ariaLabel} autoComplete="off" disabled={disabled} className={`${className} ${selectedId?"pr-8":""}`} placeholder={placeholder||`Search ${KEYS[kind]}…`} value={open?query:label} onFocus={()=>{setQuery("");setOpen(true)}} onBlur={()=>window.setTimeout(()=>setOpen(false),120)} onChange={event=>{setQuery(event.target.value);setOpen(true)}} onKeyDown={onKey}/>
  {selectedId&&!disabled&&<button type="button" aria-label="Clear selection" className="absolute right-2 top-1/2 -translate-y-1/2 rounded p-0.5 text-slate-400 hover:text-slate-700" onMouseDown={event=>event.preventDefault()} onClick={()=>choose(null)}><X size={14}/></button>}
  {open&&<ul id={listId} role="listbox" className="absolute z-[80] mt-1 max-h-64 w-full min-w-56 overflow-auto rounded-md border bg-white py-1 text-sm shadow-lg">{results.map((record,index)=><li key={record.id} role="option" aria-selected={index===active} className={`cursor-pointer px-3 py-2 ${index===active?"bg-blue-50":""}`} onMouseEnter={()=>setActive(index)} onMouseDown={event=>{event.preventDefault();choose(record)}}><span className="block truncate font-medium">{record.label}</span>{record.detail&&<span className="block truncate text-xs text-slate-500">{record.detail}</span>}</li>)}{!results.length&&<li className="px-3 py-2 text-xs text-slate-500">{loading?"Searching…":query?"No matches":"Type to search"}</li>}</ul>}
 </div>;
}
