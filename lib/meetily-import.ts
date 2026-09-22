export type MeetilyImport={
  title:string;
  externalId:string;
  startsAt:string;
  summary:string;
  decisions:string[];
  customerCommitments:string[];
  internalCommitments:string[];
  risksAndObjections:string[];
  nextSteps:string[];
  nextStepOwner:string;
  nextStepDueDate:string;
  attendeeHints:string[];
  transcript:string;
  dataGaps:string[];
};

const clean=(value:string)=>value
  .replace(/^\s*[-*+]\s+/gm,"")
  .replace(/^\s*\d+[.)]\s+/gm,"")
  .replace(/\*\*/g,"")
  .replace(/`/g,"")
  .trim();
const unique=(values:string[])=>[...new Set(values.map(value=>clean(value)).filter(Boolean))];
const sectionKey=(value:string)=>clean(value).toLowerCase().replace(/[^a-z0-9]+/g," ").trim();

function sections(markdown:string){
  const result=new Map<string,string[]>();let current="";
  for(const raw of markdown.replace(/\r/g,"").split("\n")){
    const heading=raw.match(/^\s*#{2,6}\s+(.+?)\s*$/);
    if(heading){current=sectionKey(heading[1]);if(!result.has(current))result.set(current,[]);continue}
    if(current)result.get(current)?.push(raw);
  }
  return result;
}

function sectionValues(map:Map<string,string[]>,names:string[]){
  return names.flatMap(name=>map.get(sectionKey(name))||[]);
}

function prose(lines:string[]){
  return clean(lines.filter(line=>line.trim()&&!/^\s*---+\s*$/.test(line)&&!/^\s*\|/.test(line)).join("\n"));
}

function list(lines:string[]){
  const plain=lines.filter(line=>line.trim()&&!/^\s*---+\s*$/.test(line)&&!/^\s*\|/.test(line));
  const bullet=plain.filter(line=>/^\s*(?:[-*+]|\d+[.)])\s+/.test(line));
  if(bullet.length)return unique(bullet);
  return unique(plain.join("\n").split(/\n{2,}|;\s+/));
}

function actionItems(lines:string[]){
  const table=lines.filter(line=>/^\s*\|.*\|\s*$/.test(line));
  if(table.length>=2){
    const cells=(line:string)=>line.trim().slice(1,-1).split("|").map(cell=>clean(cell));
    const headers=cells(table[0]).map(value=>sectionKey(value));
    const rows=table.slice(1).filter(line=>!/^[\s|:-]+$/.test(line));
    const items=rows.map(line=>{
      const values=cells(line),get=(...names:string[])=>{const index=headers.findIndex(header=>names.includes(header));return index>=0?values[index]||"":""};
      const owner=get("owner","assignee"),task=get("task","action","action item")||values[1]||values[0],due=get("due","due date","deadline");
      return [task,owner&&`Owner: ${owner}`,due&&`Due: ${due}`].filter(Boolean).join(" — ");
    });
    const first=cells(rows[0]||"");
    const ownerIndex=headers.findIndex(header=>["owner","assignee"].includes(header)),dueIndex=headers.findIndex(header=>["due","due date","deadline"].includes(header));
    return {items:unique(items),owner:ownerIndex>=0?first[ownerIndex]||"":"",due:dueIndex>=0?first[dueIndex]||"":""};
  }
  return {items:list(lines),owner:"",due:""};
}

function parseDate(value:string,now:Date){
  const parsed=new Date(clean(value));
  return Number.isFinite(parsed.getTime())?parsed.toISOString():now.toISOString();
}

function dueDate(value:string){
  const parsed=new Date(clean(value));
  return Number.isFinite(parsed.getTime())?parsed.toISOString().slice(0,10):"";
}

export function parseMeetilyImport(summaryInput:string,transcriptInput="",now=new Date()):MeetilyImport{
  const summary=summaryInput.trim(),providedTranscript=transcriptInput.trim(),summaryIsTranscript=/^\s*#\s+Transcript of the Meeting:/im.test(summary)&&!/^\s*##\s+(Summary|Executive Summary)/im.test(summary);
  const transcript=providedTranscript||(summaryIsTranscript?summary:"");
  const source=summaryIsTranscript?"":summary,map=sections(source);
  const summaryTitle=summary.match(/^\s*#\s+Meeting Summary:\s*(.+?)\s*$/im)?.[1];
  const transcriptHeader=(transcript||summary).match(/^\s*#\s+Transcript of the Meeting:\s*(.+?)\s+-\s+(.+?)\s*$/im);
  const genericTitle=summary.match(/^\s*#\s+(?!Meeting Summary:|Transcript of the Meeting:)(.+?)\s*$/im)?.[1];
  const externalId=clean(summary.match(/^\s*\*\*Meeting ID:\*\*\s*(.+?)\s*$/im)?.[1]||transcriptHeader?.[1]||"");
  const title=clean(summaryTitle||transcriptHeader?.[2]||genericTitle||"Meetily meeting");
  const dateValue=summary.match(/^\s*\*\*Date:\*\*\s*(.+?)\s*$/im)?.[1]||(transcript||summary).match(/^\s*##\s+Date:\s*(.+?)\s*$/im)?.[1]||"";
  const decisions=list(sectionValues(map,["Key Decisions","Decisions","Customer Decisions"]));
  const risksAndObjections=list(sectionValues(map,["Risks","Objections","Risks and Objections","Concerns"]));
  const customerCommitments=list(sectionValues(map,["Customer Commitments","Client Commitments"]));
  const internalCommitments=list(sectionValues(map,["Internal Commitments","Our Commitments"]));
  const actions=actionItems(sectionValues(map,["Action Items","Next Steps","Actions"]));
  const attendeeHints=list(sectionValues(map,["Attendees","Participants"]));
  const summaryText=prose(sectionValues(map,["Summary","Executive Summary"]))||prose(sectionValues(map,["Discussion Highlights","Highlights"]))||(!source?"":clean(source.replace(/^\s*#.*$/gm,"").replace(/^\s*\*\*(Meeting ID|Date|Copied on):\*\*.*$/gim,"").replace(/^\s*---+\s*$/gm,"")).slice(0,12000));
  const dataGaps=unique([
    !externalId?"Meetily meeting ID was not found.":"",
    !dateValue?"Meeting date was not found; the current date was used.":"",
    !attendeeHints.length?"No attendee list was found; select CRM contacts during review.":"",
    !transcript?"No transcript was supplied; only the reviewed notes will be saved.":"",
  ]);
  return {title,externalId,startsAt:parseDate(dateValue,now),summary:summaryText,decisions,customerCommitments,internalCommitments,risksAndObjections,nextSteps:actions.items,nextStepOwner:actions.owner,nextStepDueDate:dueDate(actions.due),attendeeHints,transcript,dataGaps};
}
