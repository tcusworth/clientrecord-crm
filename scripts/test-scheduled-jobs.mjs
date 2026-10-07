// Cron Trigger scheduling (lib/scheduled-jobs.ts): hourly sequences, daily maintenance at 6 AM America/Denver.
import assert from "node:assert/strict";
import { createTestContext } from "./test-helpers.mjs";

function setup() {
  const { sqlite, env, load } = createTestContext();
  env.BUCKET = { async put() {} };
  return { sqlite, ...load("lib/scheduled-jobs.ts") };
}
const runs = (sqlite, type) => sqlite.prepare("SELECT status FROM job_runs WHERE job_type=? ORDER BY id").all(type).map(row => row.status);
const at = iso => new Date(iso).getTime();
// A due sequence step that creates a task: scheduled runs must assign it to the CRM owner, not "system".
const seedDueTask = sqlite => sqlite.exec("INSERT INTO contacts(id,first_name,last_name,email,created_at) VALUES (1,'Casey','Client','casey@acme.test','2026-01-01');INSERT INTO automation_sequences(id,name,created_at,updated_at) VALUES (1,'Onboarding','now','now');INSERT INTO automation_steps(sequence_id,step_order,action_type,task_title) VALUES (1,0,'task','Call Casey');INSERT INTO automation_enrollments(sequence_id,contact_id,next_run_at,enrolled_at) VALUES (1,1,'2000-01-01 00:00:00','now')");
const taskOwners = sqlite => sqlite.prepare("SELECT owner FROM tasks ORDER BY id").all().map(row => row.owner);

// 12:00 UTC in July is 6 AM MDT (UTC-6): daily maintenance, which runs sequences itself, so no separate hourly sequences run.
let ctx = setup();
seedDueTask(ctx.sqlite);
let result = await ctx.runScheduled(at("2026-07-15T12:00:00Z"));
assert.equal(result.localHour, 6);
assert.equal(result.sequences, null);
assert.equal(result.dailyMaintenance, true);
assert.deepEqual(result.errors, []);
assert.deepEqual(runs(ctx.sqlite, "daily-maintenance"), ["Completed"]);
assert.deepEqual(runs(ctx.sqlite, "sequences"), ["Completed"]);
assert.deepEqual(taskOwners(ctx.sqlite), ["owner@example.com"]);
assert.equal(ctx.sqlite.prepare("SELECT count(*) count FROM backup_snapshots").get().count, 1);

// A second 6 AM run within 20 h: sequences again, maintenance skipped by the existing guard.
const sequencesBefore = runs(ctx.sqlite, "sequences").length;
result = await ctx.runScheduled(at("2026-07-16T12:00:00Z"));
assert.equal(result.localHour, 6);
assert.equal(result.dailyMaintenance, false);
assert.deepEqual(result.sequences, { processed: 0, failed: 0 });
assert.deepEqual(runs(ctx.sqlite, "daily-maintenance"), ["Completed"]);
assert.equal(runs(ctx.sqlite, "sequences").length, sequencesBefore + 1);

// 13:00 UTC in January is 6 AM MST (UTC-7): DST-aware.
ctx = setup();
result = await ctx.runScheduled(at("2026-01-15T13:00:00Z"));
assert.equal(result.localHour, 6);
assert.equal(result.dailyMaintenance, true);
assert.deepEqual(runs(ctx.sqlite, "daily-maintenance"), ["Completed"]);

// Other hours (incl. the 6 AM UTC-offset of the other season, and local midnight): sequences only.
for (const [iso, hour] of [["2026-07-15T13:00:00Z", 7], ["2026-01-15T12:00:00Z", 5], ["2026-07-15T06:00:00Z", 0], ["2026-11-01T12:00:00Z", 5]]) {
  ctx = setup();
  seedDueTask(ctx.sqlite);
  result = await ctx.runScheduled(at(iso));
  assert.equal(result.localHour, hour, iso);
  assert.equal(result.dailyMaintenance, null, iso);
  assert.deepEqual(result.sequences, { processed: 1, failed: 0 }, iso);
  assert.deepEqual(taskOwners(ctx.sqlite), ["owner@example.com"], iso);
  assert.deepEqual(runs(ctx.sqlite, "sequences"), ["Completed"], iso);
  assert.deepEqual(runs(ctx.sqlite, "daily-maintenance"), [], iso);
}

// A failing job is recorded (job_runs + system_events) and never rethrown; later jobs still run.
ctx = setup();
ctx.sqlite.exec("DROP TABLE automation_enrollments");
const previous = console.error; console.error = () => {};
try { result = await ctx.runScheduled(at("2026-07-15T12:00:00Z")); } finally { console.error = previous; }
assert.equal(result.sequences, null);
assert.equal(result.errors.length >= 1, true);
assert.equal(result.errors[0].job, "sequences");
assert.match(result.errors[0].message, /automation_enrollments/);
assert.ok(runs(ctx.sqlite, "sequences").every(status => status === "Failed"));
assert.ok(ctx.sqlite.prepare("SELECT count(*) count FROM system_events WHERE severity='error' AND source='scheduler'").get().count >= 1);
assert.deepEqual(runs(ctx.sqlite, "daily-maintenance"), ["Failed"]);
assert.equal(result.dailyMaintenance, false);

console.log("PASS: scheduled jobs run sequences hourly as the CRM owner, daily maintenance (instead of a duplicate sequences run) at 6 AM America/Denver (MDT and MST), fall back to sequences when the 20 h guard skips maintenance, and record failures without throwing.");
