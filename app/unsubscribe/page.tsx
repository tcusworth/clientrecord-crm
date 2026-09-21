"use client";

import { useState } from "react";
import { CheckCircle2, MailX } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

export default function UnsubscribePage(){
 const[done,setDone]=useState(false),[error,setError]=useState(""),[busy,setBusy]=useState(false);
 async function submit(form:FormData){setBusy(true);setError("");const response=await fetch("/api/unsubscribe",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({email:form.get("email")})});const result=await response.json().catch(()=>({}));setBusy(false);if(!response.ok){setError(result.error||"We could not process that request.");return}setDone(true)}
 return <main className="grid min-h-screen place-items-center bg-[#f3f5f8] p-5"><section className="w-full max-w-md rounded-2xl border bg-white p-8 text-center shadow-sm"><div className="mx-auto grid h-14 w-14 place-items-center rounded-2xl bg-[#e8edff] text-[#3968ff]">{done?<CheckCircle2 size={26}/>:<MailX size={26}/>}</div>{done?<><h1 className="mt-5 text-2xl font-semibold text-[#111b31]">You’re unsubscribed</h1><p className="mt-3 leading-7 text-slate-600">This address has been added to our suppression list and will not receive future marketing campaigns.</p></>:<><h1 className="mt-5 text-2xl font-semibold text-[#111b31]">Unsubscribe from marketing emails</h1><p className="mt-3 leading-7 text-slate-600">Enter the email address that received the message. Transactional messages may still be sent when required.</p><form action={submit} className="mt-6 grid gap-3 text-left"><label className="grid gap-2 text-sm font-medium">Email address<Input name="email" type="email" required autoComplete="email"/></label>{error&&<p className="text-sm text-red-700">{error}</p>}<Button disabled={busy}>{busy?"Processing…":"Unsubscribe"}</Button></form></>}<p className="mt-7 text-xs text-slate-400">Flatirons Creative Studio</p></section></main>;
}
