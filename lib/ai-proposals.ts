export type ProposalSection={heading:string;content:string};
export type ProposalDraft={
  title:string;
  executiveSummary:string;
  sections:ProposalSection[];
  bodyMarkdown:string;
  suggestedAmount:number;
  validUntil:string;
  confidence:"Low"|"Medium"|"High";
  explanation:string;
  dataGaps:string[];
};

type Row=Record<string,unknown>;
const clean=(value:unknown,max=12000)=>String(value??"").trim().slice(0,max);
const asList=(value:unknown,max=20)=>Array.isArray(value)?value.map(item=>clean(item,2000)).filter(Boolean).slice(0,max):[];
const date=(value:unknown)=>/^\d{4}-\d{2}-\d{2}$/.test(clean(value,10))?clean(value,10):"";
const money=(value:unknown)=>{const n=Number(value);return Number.isFinite(n)&&n>=0?Math.round(n):0};

export function normalizeProposalDraft(value:unknown):ProposalDraft{
  const row=(value&&typeof value==="object"?value:{}) as Row;
  const sections=Array.isArray(row.sections)?row.sections.map(item=>{const section=(item&&typeof item==="object"?item:{}) as Row;return {heading:clean(section.heading,160),content:clean(section.content,6000)}}).filter(section=>section.heading&&section.content).slice(0,12):[];
  const confidence=clean(row.confidence,20);
  return {
    title:clean(row.title,240)||"Proposal",
    executiveSummary:clean(row.executiveSummary,4000),
    sections,
    bodyMarkdown:clean(row.bodyMarkdown,30000),
    suggestedAmount:money(row.suggestedAmount),
    validUntil:date(row.validUntil),
    confidence:confidence==="High"||confidence==="Medium"?confidence:"Low",
    explanation:clean(row.explanation,4000),
    dataGaps:asList(row.dataGaps),
  };
}

const bullet=(items:string[])=>items.length?items.map(item=>`- ${item}`).join("\n"):"- [Confirm details with the customer]";

export function buildDeterministicProposalDraft(input:{deal:Row;company:Row|null;stakeholders:Row[];lineItems:Row[];insights:Row[];notes:Row[];activities:Row[]}){
  const companyName=clean(input.company?.name||input.deal.company,240)||"the client",dealName=clean(input.deal.name,240)||"Engagement",owner=clean(input.deal.owner,200)||"ClientRecord team";
  const activeStakeholders=input.stakeholders.filter(item=>Boolean(item.active)).map(item=>`${clean(item.contact_name,160)||"Stakeholder"}${clean(item.role,100)?` (${clean(item.role,100)})`:""}`);
  const openInsights=input.insights.filter(item=>clean(item.status,40)!=="Resolved"),criteria=openInsights.filter(item=>clean(item.kind,80)==="Decision criterion").map(item=>clean(item.detail||item.title,1000)),risks=openInsights.filter(item=>["Risk","Objection"].includes(clean(item.kind,80))).map(item=>clean(item.detail||item.title,1000));
  const items=input.lineItems.map(item=>{const quantity=Math.max(1,Number(item.quantity||1)),unit=Math.max(0,Number(item.unit_price||0)),discount=Math.max(0,Math.min(100,Number(item.discount_percent||0)));return {name:clean(item.name,240)||"Service",quantity,unit,discount,total:Math.round(quantity*unit*(100-discount)/100)}}),amount=items.reduce((sum,item)=>sum+item.total,0)||Math.max(0,Number(input.deal.value||0));
  const noteText=input.notes.filter(item=>Boolean(item.pinned)).map(item=>clean(item.body,800)).filter(Boolean).slice(0,4),recent=input.activities.slice(0,4).map(item=>clean(item.body||item.subject,800)).filter(Boolean);
  const dataGaps:string[]=[];if(!items.length)dataGaps.push("No deal line items are recorded; confirm the commercial scope and investment.");if(!activeStakeholders.length)dataGaps.push("No active deal stakeholders are recorded; confirm proposal recipients and approvers.");if(!criteria.length)dataGaps.push("No decision criteria are recorded; validate how the customer will evaluate the proposal.");if(!noteText.length&&!recent.length)dataGaps.push("There are no pinned notes or recent detailed activities to ground customer-specific scope.");
  const scope=items.length?items.map(item=>`${item.name} — ${item.quantity} × $${(item.unit/100).toLocaleString("en-US",{minimumFractionDigits:2,maximumFractionDigits:2})}${item.discount?` (${item.discount}% discount)`:""}`).join("\n"):"- [Confirm services, deliverables, and quantities]";
  const sections:ProposalSection[]=[
    {heading:"Overview",content:`${owner} proposes to support ${companyName} through ${dealName}. This draft is based only on the current ClientRecord deal record and must be reviewed before it is shared.`},
    {heading:"Objectives and success criteria",content:bullet(criteria)},
    {heading:"Recommended scope",content:scope},
    {heading:"Delivery approach",content:"- Confirm implementation milestones, responsibilities, and acceptance criteria\n- Hold regular working sessions with the agreed customer stakeholders\n- Review progress and adjust the plan through the agreed governance process"},
    {heading:"Commercials",content:items.length?`${items.map(item=>`- ${item.name}: $${(item.total/100).toLocaleString("en-US",{minimumFractionDigits:2,maximumFractionDigits:2})}`).join("\n")}\n\n**Proposed investment: $${(amount/100).toLocaleString("en-US",{minimumFractionDigits:2,maximumFractionDigits:2})}**`:`- [Confirm proposed investment and pricing assumptions]`},
    {heading:"Assumptions and open items",content:bullet([...(risks.length?risks:[]),...dataGaps])},
    {heading:"Next steps",content:"- Confirm the scope, investment, and proposal recipients\n- Resolve any open risks or objections\n- Agree the approval path and target decision date"},
  ];
  const bodyMarkdown=`# ${dealName} proposal for ${companyName}\n\n${sections.map(section=>`## ${section.heading}\n\n${section.content}`).join("\n\n")}`;
  return normalizeProposalDraft({title:`${companyName} — ${dealName} proposal`,executiveSummary:`A reviewable proposal draft for ${companyName}, based on this deal’s recorded scope, stakeholders, and commercial context.`,sections,bodyMarkdown,suggestedAmount:amount,validUntil:"",confidence:dataGaps.length<=1?"High":dataGaps.length<=3?"Medium":"Low",explanation:"Built from the deal, company, active stakeholders, line items, open deal insights, pinned notes, and recent customer activity. It does not add facts that are not recorded in ClientRecord.",dataGaps});
}

export const proposalDraftSchema={
  type:"object",additionalProperties:false,
  properties:{
    title:{type:"string"},executiveSummary:{type:"string"},sections:{type:"array",items:{type:"object",additionalProperties:false,properties:{heading:{type:"string"},content:{type:"string"}},required:["heading","content"]}},bodyMarkdown:{type:"string"},suggestedAmount:{type:"number"},validUntil:{type:"string"},confidence:{type:"string",enum:["Low","Medium","High"]},explanation:{type:"string"},dataGaps:{type:"array",items:{type:"string"}},
  },
  required:["title","executiveSummary","sections","bodyMarkdown","suggestedAmount","validUntil","confidence","explanation","dataGaps"],
} as const;
