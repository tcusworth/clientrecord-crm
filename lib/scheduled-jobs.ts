import { maybeRunDailyMaintenance, ownerEmail, runDueAutomations, systemEvent } from "@/lib/operations";

// Cron Trigger work (wrangler.jsonc "0 * * * *"): sequences every hour, daily maintenance at 6 AM Mountain time. Jobs run as the CRM
// owner so sequence-created tasks land in a real task list. At 6 AM, maintenance (which runs sequences itself) replaces the hourly run.
// Page loads still call maybeRunDailyMaintenance as a fallback; its 20 h guard keeps the two from doubling up.
export const DAILY_MAINTENANCE_TIME_ZONE = "America/Denver", DAILY_MAINTENANCE_HOUR = 6;
export type ScheduledRun = { localHour: number; sequences: { processed: number; failed: number } | null; dailyMaintenance: boolean | null; errors: { job: string; message: string }[] };

export const localHour = (time: number, timeZone = DAILY_MAINTENANCE_TIME_ZONE) => Number(new Intl.DateTimeFormat("en-US", { timeZone, hour: "numeric", hourCycle: "h23" }).format(new Date(time)));

/** Runs the jobs due at scheduledTime. Never throws: failures are logged to system_events (the jobs record their own job_runs rows). */
export async function runScheduled(scheduledTime: number): Promise<ScheduledRun> {
  const result: ScheduledRun = { localHour: localHour(scheduledTime), sequences: null, dailyMaintenance: null, errors: [] };
  const attempt = async <T,>(job: string, run: () => Promise<T>) => {
    try { return await run(); }
    catch (error) { const message = error instanceof Error ? error.message : String(error); result.errors.push({ job, message }); console.error(`scheduled ${job} failed`, error); await systemEvent("error", "job", "scheduler", `Scheduled ${job} failed: ${message}`, { job, scheduledTime: new Date(scheduledTime).toISOString() }); return null; }
  };
  const actor = ownerEmail();
  if (result.localHour === DAILY_MAINTENANCE_HOUR) result.dailyMaintenance = (await attempt("daily-maintenance", () => maybeRunDailyMaintenance(actor))) ?? false;
  if (!result.dailyMaintenance) result.sequences = await attempt("sequences", () => runDueAutomations(actor));
  return result;
}
