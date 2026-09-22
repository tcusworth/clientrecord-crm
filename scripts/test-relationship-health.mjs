import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import { DatabaseSync } from "node:sqlite";
import ts from "typescript";

const modules={},env={};
function load(file){if(modules[file])return modules[file];const module={exports:{}};const code=ts.transpileModule(fs.readFileSync(file,"utf8"),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText;const require=name=>name==="cloudflare:workers"?{env}:name.startsWith("@/")?load(name.slice(2)+".ts"):(()=>{throw new Error(`Unexpected module ${name}`)})();const run=vm.runInThisContext(`(function(require,module,exports){${code}\n})`,{filename:file});run(require,module,module.exports);modules[file]=module.exports;return module.exports}
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

const sqlite=new DatabaseSync(":memory:");sqlite.exec("PRAGMA foreign_keys=ON");for(const file of fs.readdirSync("drizzle").filter(file=>file.endsWith(".sql")).sort())sqlite.exec(fs.readFileSync(`drizzle/${file}`,"utf8"));
const DB={prepare(sql){return{args:[],bind(...args){this.args=args;return this},async all(){return{results:sqlite.prepare(sql).all(...this.args)}},async first(){return sqlite.prepare(sql).get(...this.args)||null},async run(){const result=sqlite.prepare(sql).run(...this.args);return{meta:{last_row_id:Number(result.lastInsertRowid),changes:result.changes}}}}},async batch(statements){sqlite.exec("BEGIN");try{const results=[];for(const statement of statements)results.push(await statement.run());sqlite.exec("COMMIT");return results}catch(error){sqlite.exec("ROLLBACK");throw error}}};env.DB=DB;env.CRM_ALLOWED_EMAILS="owner@example.com";
sqlite.exec("INSERT INTO deals(id,name,company,stage,owner,next_step,status,created_at,updated_at) VALUES(1,'Health test','Acme','Discovery','owner@example.com','Book review','Open','2026-06-01','2026-09-01')");
const route=load("app/api/deal-workspace/route.ts"),headers={"oai-authenticated-user-id":"owner","oai-authenticated-user-email":"owner@example.com","content-type":"application/json"};
async function get(){const response=await route.GET(new Request("https://test/api/deal-workspace?dealId=1",{headers})),body=await response.json();assert.equal(response.status,200,JSON.stringify(body));return body}
let body=await get();assert.equal(body.relationshipHealth.provisional,true);assert.equal(sqlite.prepare("SELECT count(*) count FROM deal_relationship_health_scores").get().count,1);await get();assert.equal(sqlite.prepare("SELECT count(*) count FROM deal_relationship_health_scores").get().count,1);
let response=await route.POST(new Request("https://test/api/deal-workspace",{method:"POST",headers,body:JSON.stringify({action:"saveActivity",dealId:1,type:"Call",subject:"Discovery call",body:"Discussed priorities",outcome:"Connected",happenedAt:new Date().toISOString()})}));assert.equal(response.status,200,JSON.stringify(await response.json()));body=await get();assert.equal(body.relationshipHealth.meaningfulInteractions.length,1);assert.equal(sqlite.prepare("SELECT count(*) count FROM deal_relationship_health_scores").get().count,2);assert.equal(sqlite.prepare("PRAGMA foreign_key_check").all().length,0);
console.log("PASS: relationship-health classification, weighted scoring, exclusions, provisional confidence, source-change snapshots, route integration, and FK integrity.");
