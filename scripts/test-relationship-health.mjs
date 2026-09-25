import assert from "node:assert/strict";
import { createTestContext } from "./test-helpers.mjs";

const { sqlite, load } = createTestContext();
const {calculateRelationshipHealth,meaningfulInteraction}=load("lib/relationship-health.ts"),now=new Date("2026-09-22T12:00:00.000Z"),activity=(id,type,date,outcome="",extra={})=>({id,type,subject:`${type} ${id}`,body:"Customer interaction",outcome,happened_at:date,contact_id:1,...extra});
const strong=calculateRelationshipHealth({now,deal:{created_at:"2026-06-01T00:00:00.000Z",next_step:"Confirm commercial terms"},activities:[
  activity(1,"Email sent","2026-09-20T12:00:00.000Z","Sent",{thread_key:"thread-1",response_expected:1}),
  activity(2,"Email received","2026-09-21T12:00:00.000Z","Reply received",{thread_key:"thread-1"}),
  activity(3,"Meeting","2026-09-12T12:00:00.000Z","Completed"),
  activity(4,"Call","2026-09-02T12:00:00.000Z","Connected"),
  activity(5,"Customer decision","2026-09-17T12:00:00.000Z","Approved technical approach"),
  activity(6,"Demo","2026-08-13T12:00:00.000Z","Completed"),
  activity(7,"Proposal review","2026-08-18T12:00:00.000Z","Completed"),
],tasks:[{id:1,due_date:"2026-10-01",completed:0}],stakeholders:[1,2,3,4].map(id=>({id,contact_id:id}))});
assert.equal(strong.score,100);assert.equal(strong.band,"Strong");assert.equal(strong.provisional,false);assert.equal(strong.confidence,"High");assert.equal(strong.components.reduce((sum,component)=>sum+component.weight,0),100);assert.equal(strong.meaningfulInteractions.length,6);
for(const row of [activity(8,"System update","2026-09-22T10:00:00.000Z","Completed"),activity(9,"Internal comment","2026-09-22T10:00:00.000Z","Completed"),activity(10,"Automated task","2026-09-22T10:00:00.000Z","Completed"),activity(11,"Call","2026-09-22T10:00:00.000Z","Voicemail"),activity(12,"Meeting","2026-09-22T10:00:00.000Z","Scheduled")])assert.equal(meaningfulInteraction(row,now.getTime()),null);
const provisional=calculateRelationshipHealth({now,deal:{created_at:"2026-09-20T00:00:00.000Z",next_step:"Discovery"},activities:[],tasks:[],stakeholders:[]});assert.equal(provisional.provisional,true);assert.equal(provisional.confidence,"Low");assert.equal(provisional.band,"At risk");assert.ok(provisional.dataGaps.some(gap=>gap.includes("deal history")));

sqlite.exec("INSERT INTO deals(id,name,company,stage,owner,next_step,status,created_at,updated_at) VALUES(1,'Health test','Acme','Discovery','owner@example.com','Book review','Open','2026-06-01','2026-09-01')");
const route=load("app/api/deal-workspace/route.ts"),headers={"oai-authenticated-user-id":"owner","oai-authenticated-user-email":"owner@example.com","content-type":"application/json"};
async function get(){const response=await route.GET(new Request("https://test/api/deal-workspace?dealId=1",{headers})),body=await response.json();assert.equal(response.status,200,JSON.stringify(body));return body}
let body=await get();assert.equal(body.relationshipHealth.provisional,true);assert.equal(sqlite.prepare("SELECT count(*) count FROM deal_relationship_health_scores").get().count,1);await get();assert.equal(sqlite.prepare("SELECT count(*) count FROM deal_relationship_health_scores").get().count,1);
let response=await route.POST(new Request("https://test/api/deal-workspace",{method:"POST",headers,body:JSON.stringify({action:"saveActivity",dealId:1,type:"Call",subject:"Discovery call",body:"Discussed priorities",outcome:"Connected",happenedAt:new Date().toISOString()})}));assert.equal(response.status,200,JSON.stringify(await response.json()));body=await get();assert.equal(body.relationshipHealth.meaningfulInteractions.length,1);assert.equal(sqlite.prepare("SELECT count(*) count FROM deal_relationship_health_scores").get().count,2);assert.equal(sqlite.prepare("PRAGMA foreign_key_check").all().length,0);
console.log("PASS: relationship-health classification, weighted scoring, exclusions, provisional confidence, source-change snapshots, route integration, and FK integrity.");
