import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import { DatabaseSync } from "node:sqlite";
import ts from "typescript";

const modules={},env={};
function load(file){if(modules[file])return modules[file];const module={exports:{}};const code=ts.transpileModule(fs.readFileSync(file,"utf8"),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText;const require=name=>name==="cloudflare:workers"?{env}:name.startsWith("@/")?load(name.slice(2)+".ts"):(()=>{throw new Error(`Unexpected module ${name}`)})();const run=vm.runInThisContext(`(function(require,module,exports){${code}\n})`,{filename:file});run(require,module,module.exports);modules[file]=module.exports;return module.exports}
const {calculateStakeholderCoverage,dealStakeholderRoles,normalizeDealStakeholderRole}=load("lib/stakeholder-coverage.ts"),now=new Date("2026-09-22T12:00:00.000Z");
const stage=(name,index,kind="Open")=>({key:name,name,index,openStageCount:4,probability:[25,40,60,80][index]||100,kind});
const person=(id,role,active=1)=>({id,contact_id:id,contact_name:`Person ${id}`,role,active});
const activity=(id,contactId,date)=>({id,contact_id:contactId,type:"Meeting",outcome:"Completed",subject:"Customer meeting",happened_at:date});

assert.deepEqual(dealStakeholderRoles,["Decision-maker","Economic buyer","Technical buyer","Champion","Blocker","Influencer","Legal/procurement","User","Other"]);
assert.equal(normalizeDealStakeholderRole("Legal / procurement"),"Legal/procurement");assert.equal(normalizeDealStakeholderRole("Colleague"),"Other");
const early=calculateStakeholderCoverage({now,deal:{status:"Open"},stage:stage("Qualified",0),stakeholders:[person(1,"Champion")],activities:[]});
assert.equal(early.stage.phase,"Early");assert.equal(early.findings.find(item=>item.key==="missing-decision-maker").severity,"Info");assert.equal(early.findings.some(item=>item.key==="missing-champion"),false);
const late=calculateStakeholderCoverage({now,deal:{status:"Open"},stage:stage("Proposal",2),stakeholders:[person(1,"Blocker"),person(2,"Champion",0)],activities:[]});
assert.equal(late.stage.technical,true);assert.equal(late.activeStakeholderCount,1);assert.equal(late.findings.find(item=>item.key==="single-contact").severity,"Critical");assert.equal(late.findings.find(item=>item.key==="blocker-without-champion").severity,"Critical");assert.ok(late.findings.some(item=>item.key==="missing-technical-buyer"));
const complete=calculateStakeholderCoverage({now,deal:{status:"Open"},stage:stage("Negotiation",3),stakeholders:[person(1,"Decision-maker"),person(2,"Economic buyer"),person(3,"Technical buyer"),person(4,"Champion"),person(5,"Legal/procurement")],activities:[1,2,3,4].map(id=>activity(id,id,"2026-09-20T12:00:00.000Z"))});
assert.equal(complete.stage.phase,"Contracting");assert.equal(complete.findings.length,0);assert.equal(complete.keyStakeholders.every(person=>person.engagement==="Recent"),true);
const closed=calculateStakeholderCoverage({now,deal:{status:"Won"},stage:stage("Won",4,"Won"),stakeholders:[],activities:[]});assert.equal(closed.monitored,false);assert.equal(closed.findings.length,0);

const sqlite=new DatabaseSync(":memory:");sqlite.exec("PRAGMA foreign_keys=ON");for(const file of fs.readdirSync("drizzle").filter(file=>file.endsWith(".sql")).sort())sqlite.exec(fs.readFileSync(`drizzle/${file}`,"utf8"));
const DB={prepare(sql){return{args:[],bind(...args){this.args=args;return this},async all(){return{results:sqlite.prepare(sql).all(...this.args)}},async first(){return sqlite.prepare(sql).get(...this.args)||null},async run(){const result=sqlite.prepare(sql).run(...this.args);return{meta:{last_row_id:Number(result.lastInsertRowid),changes:result.changes}}}}},async batch(statements){sqlite.exec("BEGIN");try{const results=[];for(const statement of statements)results.push(await statement.run());sqlite.exec("COMMIT");return results}catch(error){sqlite.exec("ROLLBACK");throw error}}};env.DB=DB;env.CRM_ALLOWED_EMAILS="owner@example.com";
sqlite.exec("INSERT INTO contacts(id,first_name,last_name,email,company,created_at) VALUES (1,'Ada','Buyer','ada@acme.test','Acme','2026-01-01'),(2,'Ben','Champion','ben@acme.test','Acme','2026-01-01');INSERT INTO deals(id,name,company,stage,stage_key,pipeline_key,owner,next_step,status,created_at,updated_at) VALUES(1,'Coverage test','Acme','Negotiation','Negotiation','default','owner@example.com','Complete review','Open','2026-01-01','2026-09-01')");
const route=load("app/api/deal-workspace/route.ts"),headers={"oai-authenticated-user-id":"owner","oai-authenticated-user-email":"owner@example.com","content-type":"application/json"};
async function post(payload,expected=200){const previous=console.error;console.error=()=>{};let response;try{response=await route.POST(new Request("https://test/api/deal-workspace",{method:"POST",headers,body:JSON.stringify({dealId:1,...payload})}))}finally{console.error=previous}const body=await response.json();assert.equal(response.status,expected,JSON.stringify(body));return body}
await post({action:"saveStakeholder",contactId:1,role:"Champion",active:true,isPrimary:true});assert.equal(sqlite.prepare("SELECT active FROM deal_stakeholders WHERE contact_id=1").get().active,1);
await post({action:"saveStakeholder",contactId:2,role:"Decision-maker",active:true});await post({action:"saveStakeholder",contactId:2,role:"Legal / procurement",active:true},400);
let response=await route.GET(new Request("https://test/api/deal-workspace?dealId=1",{headers})),body=await response.json();assert.equal(response.status,200,JSON.stringify(body));assert.equal(body.stakeholderCoverage.stage.phase,"Contracting");assert.ok(body.stakeholderCoverage.findings.some(item=>item.key==="missing-economic-buyer"));assert.deepEqual(body.stakeholderRoles,dealStakeholderRoles);
const champion=sqlite.prepare("SELECT id FROM deal_stakeholders WHERE contact_id=1").get();await post({action:"toggleStakeholderActive",id:champion.id,active:false});assert.equal(sqlite.prepare("SELECT active FROM deal_stakeholders WHERE id=?").get(champion.id).active,0);assert.equal(sqlite.prepare("SELECT contact_id FROM deals WHERE id=1").get().contact_id,null);assert.equal(sqlite.prepare("PRAGMA foreign_key_check").all().length,0);
console.log("PASS: standardized stakeholder roles, active-contact handling, stage-aware severity, technical and procurement gates, key-contact recency, closed-deal suppression, route integration, and FK integrity.");
