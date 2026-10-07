import { env } from "cloudflare:workers";
import { audit, type CRMUser } from "@/lib/crm-auth";
import { systemEvent } from "@/lib/operations";
import { allPersonalAccounts, type IntegrationAccount } from "./accounts";
import { syncGoogleAccount } from "./google-sync";
import { syncMicrosoftAccount } from "./microsoft-sync";

// Automatic sync of every connected Google/Microsoft account (hourly cron + daily maintenance). Audit entries are attributed to the schedule.
export const SYNC_GUARD_MINUTES = 50;
const SCHEDULE_ACTOR: CRMUser = { id: "system:schedule", email: "system:schedule", role: "owner", permissions: [] };
export type SyncAllResult = { synced: number; skipped: number; failed: { accountId: number; userEmail: string; error: string }[] };

// last_synced_at is SQLite datetime('now'): UTC "YYYY-MM-DD HH:MM:SS".
const recentlySynced = (account: IntegrationAccount, now: Date) => { const at = account.last_synced_at ? Date.parse(account.last_synced_at.replace(" ", "T") + "Z") : NaN; return Number.isFinite(at) && now.getTime() - at < SYNC_GUARD_MINUTES * 60000; };
// Always audited; the outbound webhook only fires for failures or syncs that imported something (hourly no-op syncs would be noise).
const auditSync = async (account: IntegrationAccount, outcome: "success" | "failure", details: Record<string, unknown>, webhook: boolean) => {
  try { await audit(SCHEDULE_ACTOR, "integration.sync", "integration", account.id, `Scheduled ${account.provider} sync for ${account.user_email} ${outcome === "success" ? "completed" : "failed"}`, { provider: account.provider, userEmail: account.user_email, trigger: "schedule", outcome, ...details }, { webhook }); }
  catch (error) { console.error("sync audit failed", error); }
};

/** Never throws for a single account: each failure is recorded (system_events + audit) and the rest continue. Records one job_runs row. */
export async function syncAllAccounts(now = new Date()): Promise<SyncAllResult> {
  // Another run (e.g. a page-load maintenance fallback overlapping the cron) is still going: leave the accounts to it.
  const running = await env.DB.prepare("SELECT id FROM job_runs WHERE job_type='mail-sync' AND status='Running' AND started_at>=datetime('now','-15 minutes') LIMIT 1").first();
  if (running) return { synced: 0, skipped: (await allPersonalAccounts()).length, failed: [] };
  const started = await env.DB.prepare("INSERT INTO job_runs(job_type,status,started_at) VALUES ('mail-sync','Running',datetime('now'))").run(), id = Number(started.meta.last_row_id);
  const result: SyncAllResult = { synced: 0, skipped: 0, failed: [] };
  try {
    for (const account of await allPersonalAccounts()) {
      if (account.status === "needs_reconnect" || recentlySynced(account, now)) { result.skipped++; continue; }
      try {
        const run = account.provider === "microsoft" ? syncMicrosoftAccount : syncGoogleAccount, summary = await run(account);
        result.synced++;
        await auditSync(account, "success", { emails: summary.emails, events: summary.events, skipped: summary.skipped, reviewQueued: summary.reviewQueued }, summary.emails + summary.events + summary.reviewQueued > 0);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        result.failed.push({ accountId: account.id, userEmail: account.user_email, error: message });
        await systemEvent("warning", "integration", "mail-sync", `${account.provider} sync failed for ${account.user_email}: ${message}`, { accountId: account.id, provider: account.provider, userEmail: account.user_email });
        await auditSync(account, "failure", { error: message }, true);
      }
    }
    await env.DB.prepare("UPDATE job_runs SET status='Completed',processed=?,failed=?,message=?,completed_at=datetime('now') WHERE id=?").bind(result.synced, result.failed.length, `${result.synced} synced; ${result.skipped} skipped; ${result.failed.length} failed`, id).run();
    return result;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await env.DB.prepare("UPDATE job_runs SET status='Failed',failed=1,message=?,completed_at=datetime('now') WHERE id=?").bind(message, id).run();
    throw error;
  }
}
