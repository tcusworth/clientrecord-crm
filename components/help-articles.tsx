"use client";

// Help articles for the customer portal. Backed by /api/platform-expansion: GET articles (records.view), POST saveArticle / setArticleStatus (records.edit).
// The portal (app/api/portal/route.ts) lists only Published articles for Customers or Public, shown as plain text.
import { FormEvent, useState } from "react";
import { Archive, BookOpen, Eye, EyeOff, Plus } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Panel, WorkspaceEmpty } from "@/components/workspace-primitives";
import type { Row } from "@/lib/crm-types";
import { text } from "@/lib/format";

const STATUSES=["Draft","Published","Archived"],AUDIENCES=["Customers","Public","Internal"],FILTERS=["All",...STATUSES];
const fieldClass="h-10 w-full rounded-md border bg-white px-3 text-sm";
const inPortal=(item:Row)=>text(item.status)==="Published"&&text(item.audience)!=="Internal";
const updated=(value:unknown)=>{const date=new Date(text(value));return Number.isNaN(date.valueOf())?text(value):date.toLocaleDateString()};

export function HelpArticles({articles,canEdit,busy,error,run}:{articles:Row[];canEdit:boolean;busy:boolean;error:string;run:(action:string,payload:Row,message?:string)=>Promise<boolean>}){
 const[filter,setFilter]=useState("All"),[editing,setEditing]=useState<Row|null>(null),[formKey,setFormKey]=useState(0);
 const visible=filter==="All"?articles:articles.filter(item=>text(item.status)===filter);
 const reset=()=>{setEditing(null);setFormKey(key=>key+1)};
 async function save(event:FormEvent<HTMLFormElement>){event.preventDefault();const form=Object.fromEntries(new FormData(event.currentTarget).entries());if(await run("saveArticle",{...form,id:editing?.id||undefined},editing?"Article updated":"Article created"))reset()}
 const setStatus=(item:Row,status:string,message:string)=>void run("setArticleStatus",{id:item.id,status},message).then(ok=>{if(ok&&editing?.id===item.id)reset()});
 return <div className="grid gap-6 xl:grid-cols-[1.35fr_.65fr]">
  <Panel className="overflow-hidden"><div className="flex flex-wrap items-center justify-between gap-3 border-b p-4"><div><h2 className="font-semibold">Help articles</h2><p className="mt-1 text-sm text-slate-500">Published articles for Customers or Public appear in the customer portal.</p></div><div className="flex gap-1" role="group" aria-label="Filter by status">{FILTERS.map(item=><Button key={item} size="sm" variant={filter===item?"default":"outline"} aria-pressed={filter===item} onClick={()=>setFilter(item)}>{item}</Button>)}</div></div>
   {visible.length?<div className="universal-table overflow-auto"><table><thead><tr><th>Title</th><th>Category</th><th>Audience</th><th>Status</th><th>Updated</th>{canEdit&&<th><span className="sr-only">Actions</span></th>}</tr></thead><tbody>{visible.map(item=>{const status=text(item.status);return <tr key={text(item.id)} className={editing?.id===item.id?"bg-blue-50":""}><td><button className="text-left font-medium text-blue-700 hover:underline" onClick={()=>{setEditing(item);setFormKey(key=>key+1)}}>{text(item.title)}</button>{inPortal(item)&&<span className="ml-2 text-xs text-emerald-700">In portal</span>}</td><td>{text(item.category)}</td><td>{text(item.audience)}</td><td><Badge variant={status==="Published"?"default":status==="Archived"?"outline":"secondary"}>{status}</Badge></td><td className="whitespace-nowrap text-slate-500">{updated(item.updated_at)}</td>{canEdit&&<td><div className="flex justify-end gap-1">{status!=="Published"&&<Button size="sm" variant="outline" disabled={busy} onClick={()=>setStatus(item,"Published","Article published")}><Eye size={14}/>Publish</Button>}{status==="Published"&&<Button size="sm" variant="outline" disabled={busy} onClick={()=>setStatus(item,"Draft","Article unpublished")}><EyeOff size={14}/>Unpublish</Button>}{status!=="Archived"&&<Button size="sm" variant="ghost" disabled={busy} onClick={()=>setStatus(item,"Archived","Article archived")}><Archive size={14}/>Archive</Button>}</div></td>}</tr>})}</tbody></table></div>:<WorkspaceEmpty title={articles.length?`No ${filter.toLowerCase()} articles`:"No help articles yet"} detail={canEdit?"Write answers customers can find in their portal.":"Articles your team writes will appear here."}/>}
  </Panel>
  {canEdit?<Panel className="p-5"><div className="flex items-center justify-between gap-2"><h2 className="font-semibold">{editing?"Edit article":"New article"}</h2>{editing&&<Button size="sm" variant="outline" onClick={reset}><Plus size={14}/>New</Button>}</div>
   {error&&<div role="alert" className="mt-3 rounded-md bg-red-50 p-3 text-sm text-red-700">{error}</div>}
   <form key={formKey} onSubmit={save} className="mt-4 grid gap-3">
    <label className="grid gap-1.5 text-sm font-medium">Title<Input name="title" defaultValue={text(editing?.title)} maxLength={200} required/></label>
    <label className="grid gap-1.5 text-sm font-medium">Summary<Input name="summary" defaultValue={text(editing?.summary)} maxLength={1000}/><span className="text-xs font-normal text-slate-500">Shown on the portal card. Without one, the first 180 characters of the body are shown.</span></label>
    <label className="grid gap-1.5 text-sm font-medium">Category<Input name="category" defaultValue={text(editing?.category)||"General"} maxLength={120}/></label>
    <div className="grid grid-cols-2 gap-3"><label className="grid gap-1.5 text-sm font-medium">Audience<select name="audience" defaultValue={text(editing?.audience)||"Customers"} className={fieldClass}>{AUDIENCES.map(item=><option key={item}>{item}</option>)}</select></label><label className="grid gap-1.5 text-sm font-medium">Status<select name="status" defaultValue={text(editing?.status)||"Draft"} className={fieldClass}>{STATUSES.map(item=><option key={item}>{item}</option>)}</select></label></div>
    <p className="text-xs text-slate-500">Customers see an article in their portal only when it is <strong>Published</strong> with audience <strong>Customers</strong> or <strong>Public</strong>. <strong>Internal</strong> articles stay inside the CRM.</p>
    <label className="grid gap-1.5 text-sm font-medium">Body<Textarea name="body" rows={10} defaultValue={text(editing?.body)} maxLength={24000} required/><span className="text-xs font-normal text-slate-500">Plain text. The portal shows it as-is, so Markdown and HTML are not formatted.</span></label>
    <Button disabled={busy}><BookOpen size={16}/>{editing?"Save changes":"Create article"}</Button>
   </form></Panel>
  :editing?<Panel className="p-5"><h2 className="font-semibold">{text(editing.title)}</h2><p className="mt-1 text-xs text-slate-500">{text(editing.category)} · {text(editing.audience)} · {text(editing.status)}</p><p className="mt-4 whitespace-pre-wrap text-sm leading-6 text-slate-700">{text(editing.body)}</p></Panel>
  :<Panel className="p-5 text-sm text-slate-500">You have view access. Select an article to read it.</Panel>}
 </div>;
}
