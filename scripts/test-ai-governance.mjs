import assert from "node:assert/strict";
import { createTestContext } from "./test-helpers.mjs";

const { sqlite, load } = createTestContext();
const {GET,POST}=load("app/api/ai-governance/route.ts"),headers=email=>email?{"oai-authenticated-user-id":"test-user","oai-authenticated-user-email":email,"content-type":"application/json"}:{};
async function post(action,payload={},expected=200,email="owner@example.com"){const response=await POST(new Request("https://test/api/ai-governance",{method:"POST",headers:headers(email),body:JSON.stringify({action,...payload})})),body=await response.json();assert.equal(response.status,expected,JSON.stringify(body));return body}

let response=await GET(new Request("https://test/api/ai-governance"));assert.equal(response.status,401);
sqlite.exec("INSERT INTO team_members(email,role,created_at,updated_at) VALUES ('viewer@example.com','viewer','now','now')");
response=await GET(new Request("https://test/api/ai-governance",{headers:headers("viewer@example.com")}));assert.equal(response.status,200);let body=await response.json();assert.equal(body.permissions.view,true);assert.equal(body.permissions.configure,false);assert.equal(body.providerConfigured,false);
await post("saveSettings",{},403,"viewer@example.com");
await post("saveSettings",{enabled:true,provider:"openai",model:"gpt-5-mini"},400);
await post("saveSettings",{enabled:false,provider:"openai",model:"gpt-5-mini",dailyRunLimit:50,perUserDailyLimit:10,maxContextChars:40000,resultRetentionDays:365,requireReview:true,allowSensitiveSources:false});
assert.equal(sqlite.prepare("SELECT daily_run_limit AS run_limit FROM ai_settings WHERE id=1").get().run_limit,50);
await post("createPromptVersion",{feature:"meeting-prep",name:"Invalid",systemPrompt:"This is a sufficiently long prompt.",responseSchema:"{"},400);
const first=await post("createPromptVersion",{feature:"meeting-prep",name:"Baseline",systemPrompt:"Use only the supplied CRM records and explain every conclusion.",responseSchema:'{"type":"object"}'},201);
const second=await post("createPromptVersion",{feature:"meeting-prep",name:"Refined",systemPrompt:"Use only supplied CRM evidence, identify missing context, and explain each conclusion.",responseSchema:'{"type":"object"}'},201);
assert.equal(first.version,1);assert.equal(second.version,2);
await post("activatePromptVersion",{id:first.id});await post("activatePromptVersion",{id:second.id});
assert.equal(sqlite.prepare("SELECT status FROM ai_prompt_versions WHERE id=?").get(first.id).status,"Archived");assert.equal(sqlite.prepare("SELECT status FROM ai_prompt_versions WHERE id=?").get(second.id).status,"Active");
sqlite.prepare("INSERT INTO ai_runs(id,feature,entity_type,entity_id,status,provider,model,prompt_version,input_hash,requested_by,source_count,started_at) VALUES ('run-1','meeting-prep','deal','1','Completed','openai','gpt-5-mini',2,'hash','owner@example.com',1,datetime('now'))").run();
sqlite.prepare("INSERT INTO ai_artifacts(id,run_id,feature,entity_type,entity_id,content_json,original_content_json,explanation,confidence,provider,model,prompt_version,input_hash,generated_by,generated_at) VALUES ('artifact-1','run-1','follow-up-draft','deal','1','{\"summary\":\"Draft\"}','{\"summary\":\"Draft\"}','Source-backed draft',82,'openai','gpt-5-mini',2,'hash','owner@example.com',datetime('now'))").run();
sqlite.prepare("INSERT INTO ai_artifact_sources(artifact_id,source_type,source_id,content_hash,excerpt) VALUES ('artifact-1','deal','1','source-hash','Deal summary')").run();
await post("reviewArtifact",{id:"artifact-1",status:"Edited",contentJson:'{"summary":"Approved edit"}',comment:"Corrected wording"});
assert.equal(sqlite.prepare("SELECT review_status status FROM ai_artifacts WHERE id='artifact-1'").get().status,"Edited");assert.equal(sqlite.prepare("SELECT count(*) count FROM ai_feedback_events").get().count,1);
response=await GET(new Request("https://test/api/ai-governance",{headers:headers("owner@example.com")}));body=await response.json();assert.equal(response.status,200);assert.equal(body.artifacts[0].sourceCount,1);assert.equal(body.prompts.find(prompt=>prompt.id===second.id).status,"Active");assert.ok(body.usage.total>=1);
assert.ok(sqlite.prepare("SELECT count(*) count FROM audit_logs WHERE action LIKE 'ai.%'").get().count>=5);assert.equal(sqlite.prepare("PRAGMA foreign_key_check").all().length,0);
console.log("PASS: AI permissions, secure configuration gate, prompt versioning, activation, source lineage, human review, audit history, usage reporting, and FK integrity.");
