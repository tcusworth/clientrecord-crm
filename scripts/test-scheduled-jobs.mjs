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

// 12:00 UTC in July is 6 AM MDT (UTC-6): sequences + daily maintenance.
let ctx = setup();
let result = await ctx.runScheduled(at("2026-07-15T12:00:00Z"));
assert.equal(result.localHour, 6);
assert.deepEqual(result.sequences, { processed: 0, failed: 0 });
assert.equal(result.dailyMaintenance, true);
assert.deepEqual(result.errors, []);
assert.deepEqual(runs(ctx.sqlite, "daily-maintenance"), ["Completed"]);
assert.ok(runs(ctx.sqlite, "sequences").length >= 1 && runs(ctx.sqlite, "sequences").every(status => status === "Completed"));
assert.equal(ctx.sqlite.prepare("SELECT count(*) count FROM backup_snapshots").get().count, 1);

// A second 6 AM run within 20 h: sequences again, maintenance skipped by the existing guard.
const sequencesBefore = runs(ctx.sqlite, "sequences").length;
result = await ctx.runScheduled(at("2026-07-16T12:00:00Z"));
assert.equal(result.localHour, 6);
assert.equal(result.dailyMaintenance, false);
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
  result = await ctx.runScheduled(at(iso));
  assert.equal(result.localHour, hour, iso);
  assert.equal(result.dailyMaintenance, null, iso);
  assert.deepEqual(result.sequences, { processed: 0, failed: 0 }, iso);
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
assert.equal(runs(ctx.sqlite, "sequences")[0], "Failed");
assert.ok(ctx.sqlite.prepare("SELECT count(*) count FROM system_events WHERE severity='error' AND source='scheduler'").get().count >= 1);
assert.deepEqual(runs(ctx.sqlite, "daily-maintenance"), ["Failed"]);
assert.equal(result.dailyMaintenance, false);

console.log("PASS: scheduled jobs run sequences hourly, daily maintenance at 6 AM America/Denver (MDT and MST), respect the 20 h guard, and record failures without throwing.");
