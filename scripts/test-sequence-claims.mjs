// runDueAutomations claims each due enrollment atomically, so overlapping runs (cron, page load, manual) process it once.
import assert from "node:assert/strict";
import { createTestContext } from "./test-helpers.mjs";

const { sqlite, load } = createTestContext();
const { runDueAutomations } = load("lib/operations.ts");
const due = "2000-01-01 00:00:00";
sqlite.exec(`INSERT INTO contacts(id,first_name,last_name,email,subscribed,created_at) VALUES (1,'Casey','Client','casey@acme.test',1,'2026-01-01'),(2,'Dana','Doe','dana@acme.test',1,'2026-01-01');
INSERT INTO automation_sequences(id,name,created_at,updated_at) VALUES (1,'Tasks','now','now'),(2,'Emails','now','now');
INSERT INTO automation_steps(sequence_id,step_order,delay_days,action_type,task_title) VALUES (1,0,0,'task','Call Casey'),(1,1,3,'task','Follow up');
INSERT INTO automation_steps(sequence_id,step_order,action_type,subject,body) VALUES (2,0,'email','Hello','Hi {{first_name}}');
INSERT INTO automation_enrollments(id,sequence_id,contact_id,next_run_at,enrolled_at) VALUES (1,1,1,'${due}','now')`);

// Two overlapping runs over the same due enrollment: one processes it, the other skips it.
const [first, second] = await Promise.all([runDueAutomations("owner@example.com"), runDueAutomations("owner@example.com")]);
assert.equal(first.processed + second.processed, 1);
assert.deepEqual(sqlite.prepare("SELECT title FROM tasks").all().map(row => row.title), ["Call Casey"]);
const enrollment = sqlite.prepare("SELECT current_step,status,next_run_at>datetime('now','+2 days') AS later FROM automation_enrollments WHERE id=1").get();
assert.deepEqual({ ...enrollment }, { current_step: 1, status: "Active", later: 1 });

// A failed send (Resend not configured) is not left claimed: next_run_at is restored so the next run retries it.
sqlite.exec(`INSERT INTO automation_enrollments(id,sequence_id,contact_id,next_run_at,enrolled_at) VALUES (2,2,2,'${due}','now')`);
const previous = console.error; console.error = () => {};
let result; try { result = await runDueAutomations("owner@example.com"); } finally { console.error = previous; }
assert.deepEqual(result, { processed: 0, failed: 1 });
assert.deepEqual({ ...sqlite.prepare("SELECT current_step,status,next_run_at FROM automation_enrollments WHERE id=2").get() }, { current_step: 0, status: "Active", next_run_at: due });
assert.equal(sqlite.prepare("SELECT count(*) count FROM delivery_logs WHERE status='Failed'").get().count, 1);

console.log("PASS: sequence runner claims due enrollments atomically (overlapping runs process once) and releases the claim when a send fails.");
