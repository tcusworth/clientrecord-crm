import assert from "node:assert/strict";
import { createTestContext } from "./test-helpers.mjs";

const { sqlite, load } = createTestContext();

sqlite.exec(`
INSERT INTO contacts(id,first_name,last_name,email,company,title,stage,tags,created_at,updated_at) VALUES
 (1,'Alex','Owner','alex@example.com','Acme','Director','Customer','[]','2026-01-01','2026-01-01'),
 (2,'Alex','Duplicate','duplicate@example.com','Acme','','Lead','[]','2026-01-01','2026-01-01');
INSERT INTO custom_field_definitions(id,entity_type,name,field_key,field_type,options,created_at) VALUES
 (101,'contact','Contract renewal','contract_renewal','date','[]','2026-01-01'),
 (102,'contact','Buying role','buying_role','select','["Champion","Decision-maker"]','2026-01-01'),
 (103,'company','Customer segment','customer_segment','text','[]','2026-01-01'),
 (104,'company','Shared status','shared_status','text','[]','2026-01-01'),
 (105,'contact','Shared status','shared_status','text','[]','2026-01-01');
`);
assert.throws(()=>sqlite.exec("INSERT INTO custom_field_definitions(entity_type,name,field_key,field_type,options,created_at) VALUES ('contact','Duplicate','shared_status','text','[]','2026-01-01')"));

const {POST,GET}=load("app/api/crm/route.ts");
const headers={"oai-authenticated-user-id":"owner","oai-authenticated-user-email":"owner@example.com","content-type":"application/json"};
async function post(payload,expected=200){const response=await POST(new Request("https://test/api/crm",{method:"POST",headers,body:JSON.stringify(payload)})),body=await response.json();assert.equal(response.status,expected,JSON.stringify(body));return body}
const contact={action:"updateContact",id:1,firstName:"Alex",lastName:"Owner",email:"alex@example.com",company:"Acme",title:"Director",stage:"Customer",tags:"priority",customField_101:"2027-04-30",customField_102:"Champion"};
await post(contact);
assert.equal(sqlite.prepare("SELECT value FROM custom_field_values WHERE definition_id=101 AND entity_type='contact' AND entity_id=1").get().value,"2027-04-30");
assert.equal(sqlite.prepare("SELECT value FROM custom_field_values WHERE definition_id=102 AND entity_type='contact' AND entity_id=1").get().value,"Champion");
assert.equal(sqlite.prepare("SELECT COUNT(*) count FROM custom_field_values WHERE definition_id=103").get().count,0);
await post({...contact,customField_101:"",customField_102:"Decision-maker"});
assert.equal(sqlite.prepare("SELECT COUNT(*) count FROM custom_field_values WHERE definition_id=101").get().count,0);
assert.equal(sqlite.prepare("SELECT value FROM custom_field_values WHERE definition_id=102 AND entity_id=1").get().value,"Decision-maker");
sqlite.exec("INSERT INTO custom_field_values(definition_id,entity_type,entity_id,value,updated_at) VALUES (101,'contact',2,'2028-01-15','2026-01-02')");
await post({action:"mergeContacts",keepId:1,mergeId:2});
assert.equal(sqlite.prepare("SELECT value FROM custom_field_values WHERE definition_id=101 AND entity_id=1").get().value,"2028-01-15");
assert.equal(sqlite.prepare("SELECT COUNT(*) count FROM custom_field_values WHERE entity_type='contact' AND entity_id=2").get().count,0);
const response=await GET(new Request("https://test/api/crm",{headers})),data=await response.json();
assert.equal(response.status,200,JSON.stringify(data));
assert.equal(data.customFields.length,3);
// Custom field values moved from the bootstrap to the contact detail read (GET ?resource=contact&id=).
assert.equal(data.customFieldValues,undefined);
const detail=await (await GET(new Request("https://test/api/crm?resource=contact&id=1",{headers}))).json();
assert.ok(detail.customFieldValues.length>0&&detail.customFieldValues.every(value=>value.entityType==="contact"&&value.entityId===1));
assert.ok(detail.customFieldValues.some(value=>value.definitionId===101&&value.value==="2028-01-15"));
assert.equal(sqlite.prepare("PRAGMA foreign_key_check").all().length,0);
console.log("PASS: scoped definitions, contact custom field save, validation scope, clearing, merge preservation, API reads, and FK integrity.");
