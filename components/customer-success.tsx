"use client";

import { useCallback, useEffect, useState } from "react";
import { AlertTriangle, Check, ClipboardList, HeartPulse, Plus, RefreshCw, UsersRound } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Panel } from "@/components/workspace-primitives";
import type { Row } from "@/lib/crm-types";
import { money, text } from "@/lib/format";

type Data = { account: { email: string }; plans: Row[]; companies: Row[]; renewalDeals: Row[]; alerts: Row[] };
const band = (score: number) => score >= 80 ? "Strong" : score >= 60 ? "Stable" : score >= 40 ? "Attention" : "At risk";
const color = (value: string) => value === "Critical" || value === "At risk" ? "destructive" : value === "High" || value === "Attention" ? "secondary" : "default";

export function CustomerSuccessWorkspace() {
  const [data, setData] = useState<Data | null>(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState("");
  const [editing, setEditing] = useState<Row | null>(null);
  const [creating, setCreating] = useState(false);
  const load = useCallback(async () => {
    const response = await fetch("/api/customer-success", { cache: "no-store" });
    const body = await response.json() as Data & { error?: string };
    if (!response.ok) throw new Error(body.error || "Customer success could not load.");
    setData(body); setError("");
  }, []);
  useEffect(() => { void load().catch(reason => setError(reason instanceof Error ? reason.message : "Customer success could not load.")); }, [load]);
  const run = async (action: string, payload: Row = {}, message = "Saved") => {
    setBusy(action); setError("");
    try {
      const response = await fetch("/api/customer-success", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action, ...payload }) });
      const body = await response.json() as { error?: string };
      if (!response.ok) throw new Error(body.error || "The customer plan could not be saved.");
      await load(); setNotice(message); window.setTimeout(() => setNotice(""), 2600); return true;
    } catch (reason) { setError(reason instanceof Error ? reason.message : "The customer plan could not be saved."); return false; }
    finally { setBusy(""); }
  };
  if (!data) return <Panel rounded="2xl" className="p-6 text-sm text-slate-500">{error || "Loading customer success…"}</Panel>;
  const availableCompanies = data.companies.filter(company => !data.plans.some(plan => Number(plan.company_id) === Number(company.id)));
  return <>
    {error && <div className="mb-4 rounded-xl bg-red-50 p-4 text-sm text-red-700">{error}</div>}
    {notice && <div className="mb-4 flex items-center gap-2 rounded-xl bg-emerald-50 p-4 text-sm text-emerald-800"><Check size={16}/>{notice}</div>}
    <div className="mb-6 flex flex-wrap items-end justify-between gap-4"><div><div className="mb-1 text-sm font-semibold text-[#3968ff]">Post-sale workspace</div><h1 className="text-2xl font-semibold tracking-[-.025em] md:text-[30px]">Customer success & renewals</h1><p className="mt-1 text-sm text-slate-500">Keep onboarding, adoption, account plans, risks, expansion, and renewals in one accountable view.</p></div><Button onClick={() => setCreating(true)}><Plus size={16}/>Create customer plan</Button></div>
    <div className="mb-6 grid gap-4 md:grid-cols-3"><Metric icon={<HeartPulse size={16}/>} label="Customer plans" value={data.plans.length}/><Metric icon={<RefreshCw size={16}/>} label="Renewal pipeline" value={data.renewalDeals.length}/><Metric icon={<AlertTriangle size={16}/>} label="Needs attention" value={data.alerts.length}/></div>
    {data.alerts.length > 0 && <Panel rounded="2xl" className="mb-6 overflow-hidden"><div className="border-b p-5"><div className="flex items-center gap-2"><AlertTriangle size={18} className="text-amber-600"/><h2 className="font-semibold">Proactive risk alerts</h2></div><p className="mt-1 text-sm text-slate-500">Health below 40, high/critical churn risk, or renewals due within 90 days.</p></div>{data.alerts.map(alert => <div key={text(alert.id)} className="flex flex-wrap items-center justify-between gap-3 border-b p-4 last:border-0"><div><strong>{text(alert.companyName)}</strong><p className="mt-1 text-sm text-slate-600">Health {text(alert.healthScore)} · {text(alert.churnRisk)} churn risk · renewal {text(alert.renewalDate || "not set")}</p></div><Badge variant={color(text(alert.churnRisk)) as "default"}>{text(alert.churnRisk)} risk</Badge></div>)}</Panel>}
    <Panel rounded="2xl" className="overflow-hidden"><div className="border-b p-5"><div className="flex items-center gap-2"><ClipboardList size={18}/><h2 className="font-semibold">Account plans</h2></div><p className="mt-1 text-sm text-slate-500">Objectives, stakeholders, risks, and the next executive touchpoint stay visible here.</p></div>{data.plans.map(plan => <PlanRow key={text(plan.id)} plan={plan} busy={Boolean(busy)} edit={() => setEditing(plan)} renew={() => void run("createRenewalDeal", { id: plan.id }, "Renewal deal created")}/>) }{!data.plans.length && <div className="p-10 text-center text-sm text-slate-500">Create the first plan for an active customer to start tracking onboarding and renewal health.</div>}</Panel>
    <Panel rounded="2xl" className="mt-6 overflow-hidden"><div className="border-b p-5"><div className="flex items-center gap-2"><UsersRound size={18}/><h2 className="font-semibold">Renewal pipeline</h2></div></div>{data.renewalDeals.map(deal => <div key={text(deal.id)} className="flex flex-wrap items-center justify-between gap-4 border-b p-4 last:border-0"><div><strong>{text(deal.name)}</strong><p className="mt-1 text-sm text-slate-600">{text(deal.company)} · close {text(deal.closeDate || "—")}</p></div><div className="text-right"><Badge variant="secondary">{text(deal.stage)}</Badge><p className="mt-1 text-sm font-semibold">{money(deal.value)}</p></div></div>)}{!data.renewalDeals.length && <div className="p-8 text-center text-sm text-slate-500">Renewal deals created from account plans will appear here.</div>}</Panel>
    {(editing || creating) && <PlanDialog plan={editing || undefined} companies={creating ? availableCompanies : data.companies} account={data.account.email} busy={Boolean(busy)} close={() => { setEditing(null); setCreating(false); }} save={async form => { if (await run("savePlan", Object.fromEntries(form.entries()), "Customer plan saved")) { setEditing(null); setCreating(false); } }}/>} 
  </>;
}

function Metric({ icon, label, value }: { icon: React.ReactNode; label: string; value: number }) { return <Panel rounded="2xl" className="p-5"><div className="flex items-center gap-2 text-sm text-slate-500">{icon}{label}</div><div className="mt-2 text-3xl font-semibold">{value}</div></Panel>; }
function PlanRow({ plan, busy, edit, renew }: { plan: Row; busy: boolean; edit: () => void; renew: () => void }) { const health = Number(plan.health_score || 0); return <div className="grid gap-4 border-b p-5 last:border-0 lg:grid-cols-[1.5fr_.8fr_auto]"><div><div className="flex flex-wrap items-center gap-2"><strong>{text(plan.company_name)}</strong><Badge variant={color(band(health)) as "default"}>{band(health)}</Badge><Badge variant="secondary">{text(plan.status)}</Badge></div><p className="mt-2 text-sm text-slate-600">{text(plan.risks) || "No recorded risks."}</p><div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-xs text-slate-500"><span>Onboarding target {text(plan.onboarding_target || "—")}</span><span>Executive touchpoint {text(plan.next_executive_touchpoint || "—")}</span><span>Renewal {text(plan.renewal_date || "—")}</span></div></div><div className="grid grid-cols-2 gap-3 text-sm"><div><span className="block text-xs text-slate-500">Health</span><strong>{health}/100</strong></div><div><span className="block text-xs text-slate-500">Adoption</span><strong>{text(plan.adoption_score)}/100</strong></div><div><span className="block text-xs text-slate-500">ARR</span><strong>{money(plan.annual_value)}</strong></div><div><span className="block text-xs text-slate-500">Expansion</span><strong>{text(plan.expansion_potential)}</strong></div></div><div className="flex flex-wrap items-center gap-2"><Button size="sm" variant="outline" onClick={edit}>Edit plan</Button><Button size="sm" disabled={Boolean(plan.renewal_deal_id) || busy} onClick={renew}>{plan.renewal_deal_id ? "Renewal linked" : "Create renewal"}</Button></div></div>; }

function PlanDialog({ plan, companies, account, busy, close, save }: { plan?: Row; companies: Row[]; account: string; busy: boolean; close: () => void; save: (form: FormData) => Promise<void> }) {
  const objectives = (() => { try { const parsed = JSON.parse(text(plan?.objectives_json || "[]")); return Array.isArray(parsed) ? parsed.join("\n") : ""; } catch { return ""; } })();
  return <div className="fixed inset-0 z-50 grid place-items-center bg-black/35 p-4" onClick={close}><Panel rounded="2xl" className="max-h-[94vh] w-full max-w-3xl overflow-y-auto p-6"><form className="grid gap-4" onClick={event => event.stopPropagation()} onSubmit={event => { event.preventDefault(); void save(new FormData(event.currentTarget)); }}>
    {plan && <input type="hidden" name="companyId" value={text(plan.company_id)}/>}<div className="flex items-start justify-between gap-3"><div><h2 className="text-lg font-semibold">{plan ? "Update customer plan" : "Create customer plan"}</h2><p className="mt-1 text-sm text-slate-500">Guide onboarding, executive alignment, expansion, and renewal.</p></div><Button type="button" variant="ghost" onClick={close}>Close</Button></div>
    <div className="grid gap-3 sm:grid-cols-2"><select required name={plan ? "companyDisplay" : "companyId"} defaultValue={text(plan?.company_id || "")} disabled={Boolean(plan)} className="h-10 rounded-md border bg-white px-3"><option value="">Choose customer</option>{companies.map(company => <option key={text(company.id)} value={text(company.id)}>{text(company.name)}</option>)}</select><Input name="owner" defaultValue={text(plan?.owner || account)} placeholder="Owner"/><select name="status" defaultValue={text(plan?.status || "Onboarding")} className="h-10 rounded-md border bg-white px-3"><option>Onboarding</option><option>Active</option><option>Renewing</option><option>At risk</option><option>Churned</option></select><select name="churnRisk" defaultValue={text(plan?.churn_risk || "Low")} className="h-10 rounded-md border bg-white px-3"><option>Low</option><option>Medium</option><option>High</option><option>Critical</option></select><Input name="onboardingStart" type="date" defaultValue={text(plan?.onboarding_start)}/><Input name="onboardingTarget" type="date" defaultValue={text(plan?.onboarding_target)}/><Input name="renewalDate" type="date" defaultValue={text(plan?.renewal_date)}/><Input name="nextExecutiveTouchpoint" type="date" defaultValue={text(plan?.next_executive_touchpoint)}/><Input name="healthScore" type="number" min="0" max="100" defaultValue={text(plan?.health_score || 60)} placeholder="Health score"/><Input name="adoptionScore" type="number" min="0" max="100" defaultValue={text(plan?.adoption_score || 0)} placeholder="Adoption score"/><Input name="annualValue" type="number" min="0" defaultValue={text(plan?.annual_value || 0)} placeholder="Annual value in cents"/><select name="expansionPotential" defaultValue={text(plan?.expansion_potential || "Unknown")} className="h-10 rounded-md border bg-white px-3"><option>Unknown</option><option>None</option><option>Low</option><option>Medium</option><option>High</option></select></div>
    <Textarea name="objectives" defaultValue={objectives} rows={3} placeholder="Objectives — one per line"/><Textarea name="stakeholderNotes" defaultValue={text(plan?.stakeholder_notes)} rows={3} placeholder="Key stakeholders, sponsors, and relationship notes"/><Textarea name="risks" defaultValue={text(plan?.risks)} rows={3} placeholder="Risks, adoption blockers, or renewal concerns"/><Textarea name="notes" defaultValue={text(plan?.notes)} rows={3} placeholder="Account plan and next actions"/><Button disabled={busy}>{plan ? "Save plan" : "Create plan"}</Button>
  </form></Panel></div>;
}
