import assert from "node:assert/strict";
import { createSqlite } from "./test-helpers.mjs";

const db = createSqlite();

const now = new Date().toISOString();
db.prepare("INSERT INTO custom_object_types(id,key,singular_name,plural_name,description,icon,title_field_key,status,created_by,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)").run("type-installation","installations","Installation","Installations","Customer equipment","boxes","name","Active","owner@example.com",now,now);
db.prepare("INSERT INTO custom_object_fields(id,object_type_id,key,label,field_type,options_json,required,sort_order,show_in_list,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)").run("field-name","type-installation","name","Installation name","text","[]",1,0,1,now,now);
db.prepare("INSERT INTO custom_object_fields(id,object_type_id,key,label,field_type,options_json,required,sort_order,show_in_list,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)").run("field-value","type-installation","contract_value","Contract value","currency","[]",0,1,1,now,now);
db.prepare("INSERT INTO custom_object_records(id,object_type_id,display_name,values_json,owner,status,created_by,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?)").run("record-one","type-installation","Line 4 controller",JSON.stringify({name:"Line 4 controller",contract_value:125000}),"owner@example.com","Active","owner@example.com",now,now);
db.prepare("INSERT INTO custom_relationship_types(id,name,from_type,to_type,from_label,to_label,cardinality,created_by,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?)").run("relation-company","Installed equipment","company","custom:type-installation","Has installations","Installed at","one_to_many","owner@example.com",now,now);
db.prepare("INSERT INTO custom_relationships(id,relationship_type_id,from_entity_type,from_entity_id,to_entity_type,to_entity_id,note,created_by,created_at) VALUES(?,?,?,?,?,?,?,?,?)").run("link-one","relation-company","company","1","custom:type-installation","record-one","Primary production line","owner@example.com",now);
db.prepare("INSERT INTO custom_object_layouts(id,object_type_id,name,sections_json,is_default,created_at,updated_at) VALUES(?,?,?,?,?,?,?)").run("layout-one","type-installation","Default",JSON.stringify([{title:"Commercial",fieldKeys:["name","contract_value"]}]),1,now,now);
db.prepare("INSERT INTO custom_rollup_definitions(id,object_type_id,key,label,relationship_type_id,aggregate,source_field_key,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?)").run("rollup-one","type-installation","linked_companies","Linked companies","relation-company","count",null,now,now);

assert.equal(db.prepare("SELECT count(*) AS count FROM custom_object_records WHERE object_type_id=?").get("type-installation").count,1);
assert.equal(db.prepare("SELECT to_label AS label FROM custom_relationship_types WHERE id=?").get("relation-company").label,"Installed at");
assert.equal(db.prepare("SELECT count(*) AS count FROM custom_relationships WHERE to_entity_id=?").get("record-one").count,1);
assert.throws(()=>db.prepare("INSERT INTO custom_object_fields(id,object_type_id,key,label,field_type,options_json,required,sort_order,show_in_list,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)").run("field-duplicate","type-installation","name","Duplicate","text","[]",0,2,1,now,now));
assert.throws(()=>db.prepare("INSERT INTO custom_object_records(id,object_type_id,display_name,values_json,owner,status,created_by,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?)").run("record-invalid","missing","Invalid","{}","","Active","owner@example.com",now,now));

console.log("PASS: custom object definitions, typed records, layouts, bidirectional relationship metadata, rollups, uniqueness and foreign keys.");
