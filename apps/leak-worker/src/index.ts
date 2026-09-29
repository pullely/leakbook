import type { Env } from "./env.js";
import { route } from "./router.js";
import { runScheduledClockSweep } from "./context.js";

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    return route(request, env);
  },

  /** LB3: the daily repair-clock sweep (`0 14 * * *`, declared in wrangler.template.jsonc). */
  async scheduled(_controller: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(runScheduledClockSweep(env).then(() => undefined));
  },
} satisfies ExportedHandler<Env>;
