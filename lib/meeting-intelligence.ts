type Row=Record<string,unknown>;

export type MeetingPrepBrief={
  companyAndAttendeeSummary:string;
  currentDealPosition:string;
  lastMeaningfulInteraction:string;
  unresolvedCommitments:string[];
  risksAndObjections:string[];
  stakeholderConcerns:string[];
  suggestedAgenda:string[];
  recommendedQuestions:string[];
  confidence:"Low"|"Medium"|"High";
  dataGaps:string[];
  sourcesUsed:string[];
  freshnessTime:string;
};

const text=(value:unknown)=>String(value??"").trim();
const list=(value:unknown):string[]=>{try{const parsed=JSON.parse(String(value||"[]"));return Array.isArray(parsed)?parsed.map(item=>typeof item==="string"?item:text((item as Row)?.text||item)).filter(Boolean):[]}catch{return []}};
const unique=(items:string[])=>[...new Set(items.map(item=>item.trim()).filter(Boolean))];
const dollars=(value:unknown)=>new Intl.NumberFormat("en-US",{style:"currency",currency:"USD",maximumFractionDigits:0}).format(Number(value||0)/100);
const date=(value:unknown)=>{const parsed=new Date(String(value||""));return Number.isFinite(parsed.getTime())?parsed.toLocaleDateString("en-US",{month:"short",day:"numeric",year:"numeric"}):"unknown date"};

export function parseMeetingList(value:unknown){return list(value)}

export function buildMeetingPreparationBrief(input:{
  now?:Date;deal:Row;company:Row|null;meeting:Row|null;attendees:Row[];stakeholders:Row[];activities:Row[];meetings:Row[];notes:Row[];tasks:Row[];insights:Row[];reviews:Row[];proposals:Row[];
  relationshipHealth:{score:number;band:string;provisional:boolean;meaningfulInteractions:Row[]};coverage:{findings:Array<{title:string;detail:string;severity:string}>;keyStakeholders:Array<{name:string;role:string;engagement:string}>};nextAction:Row|null;dealHealth:{score:number;status:string};freshnessTime:string;
}):MeetingPrepBrief{
  const {deal,company,meeting}=input,meetingAttendees=input.attendees.length?input.attendees:input.stakeholders.filter(item=>item.active===undefined||Boolean(item.active));
  const attendeeLabels=meetingAttendees.map(item=>{const name=text(item.contact_name||item.name||item.email)||"Unnamed attendee",role=text(item.role||item.title);return role?`${name} (${role})`:name});
  const companyName=text(company?.name||deal.company)||"the account",companyDetails=unique([text(company?.industry),text(company?.tier)&&`${text(company?.tier)} tier`,text(company?.territory)&&`${text(company?.territory)} territory`]);
  const companyAndAttendeeSummary=`${companyName}${companyDetails.length?` — ${companyDetails.join(", ")}`:""}. ${attendeeLabels.length?`Attendees: ${attendeeLabels.join(", ")}.`:"No attendees are linked yet."}`;
  const positionBits=[`${text(deal.name)||"This deal"} is in ${text(deal.stage)||"an unspecified stage"}`,Number(deal.value)?`with a value of ${dollars(deal.value)}`:"without a recorded value",`deal health ${input.dealHealth.score}/100 (${input.dealHealth.status})`,`relationship health ${input.relationshipHealth.score}/100 (${input.relationshipHealth.provisional?"provisional, ":""}${input.relationshipHealth.band})`];
  const currentDealPosition=`${positionBits.join(", ")}. ${text(deal.next_step)?`Recorded next step: ${text(deal.next_step)}.`:"No next step is recorded."}`;
  const meaningful=input.relationshipHealth.meaningfulInteractions[0],lastMeaningfulInteraction=meaningful?`${text(meaningful.kind||meaningful.type)} on ${date(meaningful.date||meaningful.happened_at)}: ${text(meaningful.summary||meaningful.subject||meaningful.body)}`:"No meaningful customer interaction is recorded.";
  const priorCompleted=input.meetings.filter(item=>String(item.id)!==String(meeting?.id)&&text(item.status)==="Completed");
  const unresolvedCommitments=unique([
    ...priorCompleted.flatMap(item=>[...list(item.customer_commitments_json).map(value=>`Customer: ${value}`),...list(item.internal_commitments_json).map(value=>`Internal: ${value}`),...list(item.next_steps_json).map(value=>`Next step: ${value}`)]),
    ...input.tasks.filter(item=>!item.completed).map(item=>`${text(item.title)} — ${text(item.owner)||"unassigned"}, due ${date(item.due_date)}`),
  ]).slice(0,12);
  const risksAndObjections=unique(input.insights.filter(item=>["Risk","Objection"].includes(text(item.kind))&&text(item.status)!=="Resolved").map(item=>`${text(item.kind)} · ${text(item.title)}${text(item.detail)?`: ${text(item.detail)}`:""}`)).slice(0,10);
  const stakeholderConcerns=unique([
    ...input.coverage.findings.map(item=>`${item.severity}: ${item.title} — ${item.detail}`),
    ...input.coverage.keyStakeholders.filter(item=>item.engagement!=="Recent").map(item=>`${item.name} (${item.role}) has ${item.engagement.toLowerCase()}.`),
  ]).slice(0,10);
  const suggestedAgenda=unique([
    text(meeting?.subject)&&`Confirm the purpose and desired outcome for ${text(meeting?.subject)}.`,
    unresolvedCommitments.length?"Review commitments and close overdue follow-ups.":"Confirm responsibilities and next steps from this meeting.",
    risksAndObjections.length?"Address the highest-priority risk or objection.":"Confirm whether any new risks or objections have emerged.",
    stakeholderConcerns.length?"Close the most important stakeholder coverage gap.":"Confirm the buying group remains aligned.",
    input.proposals.some(item=>["Sent","Draft"].includes(text(item.status)))?"Review the active proposal, commercial assumptions, and approval path.":"Confirm the commercial path and decision process.",
    text(input.nextAction?.action)||"Agree the single next action, owner, and due date.",
  ]).slice(0,7);
  const recommendedQuestions=unique([
    unresolvedCommitments.length?"Which previous commitment is most at risk, and what would unblock it?":"What must be accomplished before the next customer interaction?",
    risksAndObjections.length?"Which concern could still prevent a decision?":"What concern has not yet been discussed openly?",
    stakeholderConcerns.length?"Who else must be involved before this can advance?":"Is anyone outside this group required for the decision?",
    input.reviews.some(item=>text(item.status)==="Requested")?"What is still needed to secure the pending approval?":"What approvals remain before the deal can close?",
    input.proposals.some(item=>text(item.status)==="Sent")?"Does the current proposal match the customer’s decision criteria?":"What commercial or technical evidence would make the next step easier?",
    deal.close_date?`Is the ${date(deal.close_date)} close date still supported by the customer’s process?`:"What is a realistic close date based on the customer’s process?",
  ]).slice(0,7);
  const dataGaps=unique([!company&&"No permanent company relationship is available.",!meetingAttendees.length&&"No attendees are linked to this meeting.",!input.activities.length&&"No recent deal activity is available.",!priorCompleted.length&&"No earlier structured meeting record is available.",!input.notes.length&&"No pinned notes are available."].filter((item):item is string=>Boolean(item)));
  const evidenceCount=input.activities.length+input.notes.length+input.tasks.length+input.insights.length+input.stakeholders.length+input.meetings.length,confidence=evidenceCount>=12&&dataGaps.length<=1?"High":evidenceCount>=5?"Medium":"Low";
  const sourcesUsed=unique(["Deal record",company&&"Company record",meeting&&"Meeting record",meetingAttendees.length&&"Meeting attendees",input.activities.length&&"Recent customer activity",input.notes.length&&"Pinned notes",input.tasks.length&&"Open deal tasks",input.insights.length&&"Deal risks and objections",input.stakeholders.length&&"Stakeholder map",input.meetings.length&&"Structured meeting history",input.proposals.length&&"Proposals",input.reviews.length&&"Approvals and reviews","Relationship health","Stakeholder coverage","Next-best action"].filter((item):item is string=>Boolean(item)));
  return {companyAndAttendeeSummary,currentDealPosition,lastMeaningfulInteraction,unresolvedCommitments,risksAndObjections,stakeholderConcerns,suggestedAgenda,recommendedQuestions,confidence,dataGaps,sourcesUsed,freshnessTime:input.freshnessTime};
}
