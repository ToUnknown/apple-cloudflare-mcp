export { CreationReceipt } from "./creation-durable";
import { provider } from "./auth";
import type { CalendarEnv } from "./env";
export default {
  async fetch(
    request: Request,
    env: CalendarEnv,
    ctx: ExecutionContext,
  ): Promise<Response> {
    try {
      const origin = new URL(env.PUBLIC_ORIGIN);
      if (
        origin.protocol !== "https:" ||
        origin.origin !== env.PUBLIC_ORIGIN ||
        origin.username ||
        origin.password
      )
        return new Response("Set PUBLIC_ORIGIN to the deployed HTTPS origin", {
          status: 503,
        });
      const url = new URL(request.url);
      if (url.origin !== env.PUBLIC_ORIGIN)
        return new Response("Host refused", { status: 403 });
      const requestOrigin = request.headers.get("origin");
      if (
        requestOrigin &&
        ![env.PUBLIC_ORIGIN, "https://chatgpt.com"].includes(requestOrigin)
      )
        return new Response("Origin refused", { status: 403 });
      return await provider(env.PUBLIC_ORIGIN).fetch(request, env, ctx);
    } catch {
      return new Response("Calendar service unavailable", { status: 503 });
    }
  },
} satisfies ExportedHandler<CalendarEnv>;
