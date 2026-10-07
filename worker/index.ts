import handler from "vinext/server/fetch-handler";
import { runScheduled } from "@/lib/scheduled-jobs";

// Worker entry: vinext serves every request; the hourly Cron Trigger (wrangler.jsonc "triggers") runs lib/scheduled-jobs.
export default {
  fetch: (request, env, ctx) => handler.fetch(request, env, ctx),
  scheduled: (controller, _env, ctx) => { ctx.waitUntil(runScheduled(controller.scheduledTime)); },
} satisfies ExportedHandler<Cloudflare.Env>;
