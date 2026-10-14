import { DurableObject } from "cloudflare:workers";
import { MailEventEngine, type Principal, type Subscription, type Position } from "./events";
import { EventError } from "./event-webhook";
import { scanInbox, scanInboxBatch } from "./event-imap";
import { withImap } from "./mail";
import { providerOptions } from "./index";
import { getOAuthApi } from "@cloudflare/workers-oauth-provider";
import type { AppEnv } from "./types";
import { z } from "zod";
import { seal, unseal } from "./event-crypto";

import { PermissionCache, POLL_MS, pollDelay, type PermissionSnapshot, type Grant } from "./event-permissions";

export class MailEvents extends DurableObject<AppEnv> {
  private queue: Promise<unknown> = Promise.resolve();
  private serial<T>(action: () => Promise<T>): Promise<T> {
    const next = this.queue.then(action, action);
    this.queue = next.catch(() => {});
    return next;
  }
  private permissions() {
    return new PermissionCache({
      load: async () => {
        const value = await this.ctx.storage.get<string>('permissions');
        return value ? unseal<PermissionSnapshot>(value, this.env.EVENTS_ENCRYPTION_KEY, 'permissions') : undefined;
      },
      save: async value => { await this.ctx.storage.put('permissions', await seal(value, this.env.EVENTS_ENCRYPTION_KEY, 'permissions')); },
      fetch: async () => {
        const api = getOAuthApi(providerOptions(this.env), this.env);
        const result: Grant[] = [];
        let cursor: string | undefined;
        for (let page = 0; page < 10; page++) {
          const grants = await api.listUserGrants('owner', {limit: 100, cursor});
          result.push(...grants.items.map(g => ({id:g.id, clientId:g.clientId, scope:g.scope, expiresAt:g.expiresAt})));
          if (!grants.cursor) return result;
          cursor = grants.cursor;
        }
        throw new Error('Grant pagination bound exceeded');
      }
    });
  }
  private engine(scan?: (p: Position) => ReturnType<typeof scanInbox>) {
    const permissions = this.permissions();
    return new MailEventEngine({
      origins: this.env.EVENT_CALLBACK_ORIGINS ?? "",
      load: async (id) => {
        const value = await this.ctx.storage.get<string>("sub:" + id);
        return value
          ? unseal(value, this.env.EVENTS_ENCRYPTION_KEY, id)
          : undefined;
      },
      save: async (id, value) => {
        const data = await seal(value, this.env.EVENTS_ENCRYPTION_KEY, id);
        if (Buffer.byteLength(data) > 120000)
          throw new Error("Subscription storage bound exceeded");
        await this.ctx.storage.put("sub:" + id, data);
      },
      remove: async (id) => {
        await this.ctx.storage.delete("sub:" + id);
      },
      ids: () => this.ids(),
      baseline: () =>
        withImap(this.env, async (c) => (await scanInbox(c)).position),
      scan: scan ?? ((p) => withImap(this.env, (c) => scanInbox(c, p))),
      authorized: (p, fresh) => permissions.authorized(p, fresh),
    });
  }
  private async ids() {
    return [
      ...(await this.ctx.storage.list({ prefix: "sub:", limit: 6 })).keys(),
    ].map((k) => k.slice(4));
  }
  async fetch(request: Request): Promise<Response> {
    return this.serial(async () => {
      if (String(this.env.MAIL_EVENTS_ENABLED) !== "true")
        return Response.json({
          error: {
            code: -32024,
            message: "Mail events are not enabled by the owner",
          },
        });
      try {
        const { method, principal, params } = (await request.json()) as {
          method: string;
          principal: Principal;
          params: unknown;
        };
        if (
          principal.userId !== "owner" ||
          !principal.clientId ||
          !principal.grantId
        )
          throw new EventError(-32024, "Forbidden");
        // Schedule before writing state: a crash between write and response cannot strand subscriptions.
        if (await this.ctx.storage.getAlarm() === null) await this.ctx.storage.setAlarm(Date.now() + POLL_MS);
        const engine = this.engine();
        const result =
          method === "events/subscribe"
            ? await engine.subscribe(principal, params)
            : method === "events/unsubscribe"
              ? await engine.unsubscribe(principal, params)
              : undefined;
        if (result === undefined)
          throw new EventError(-32601, "Unknown event method");
        if (!(await this.ids()).length) await this.ctx.storage.deleteAlarm();
        return Response.json({ result });
      } catch (e) {
        return Response.json({
          error:
            e instanceof EventError
              ? { code: e.code, message: e.message, data: { reason: e.reason } }
              : e instanceof z.ZodError
                ? { code: -32602, message: "Invalid event arguments" }
                : {
                    code: -32603,
                    message:
                      "Subscription operation failed; check event configuration and connectivity",
                  },
        });
      }
    });
  }
  async alarm() {
    return this.serial(async () => {
      if (String(this.env.MAIL_EVENTS_ENABLED) !== "true") {
        await this.ctx.storage.deleteAll();
        return;
      }
      await this.ctx.storage.setAlarm(Date.now() + POLL_MS);
      const permissions = this.permissions();
      const states: Subscription[] = [];
      let failed = false;
      for (const id of await this.ids()) {
        try {
          const raw = await this.ctx.storage.get<string>('sub:' + id);
          if (!raw) continue;
          const state = await unseal(raw, this.env.EVENTS_ENCRYPTION_KEY, id);
          if (state.expires <= Date.now() || !await permissions.authorized(state.principal)) {
            await this.ctx.storage.delete('sub:' + id);
          } else if (!state.pending.length) states.push(state);
        } catch { failed = true; }
      }
      const scans = new Map<string, Awaited<ReturnType<typeof scanInbox>>>();
      const key = (p: Position) => JSON.stringify(p);
      if (states.length) {
        try {
          const results = await withImap(this.env, c => scanInboxBatch(c, states.map(s => s.position)));
          states.forEach((state, i) => scans.set(key(state.position), results[i]!));
        } catch { failed = true; }
      }
      const engine = this.engine(async p => {
        const result = scans.get(key(p));
        if (!result) throw new Error('Shared scan unavailable');
        return result;
      });
      for (const id of await this.ids()) {
        try { await engine.tick(id); }
        catch { failed = true; }
      }
      if (!(await this.ids()).length) {
        await this.ctx.storage.deleteAlarm();
        await this.ctx.storage.delete(['permissions', 'failures']);
      } else {
        const failures = failed ? (await this.ctx.storage.get<number>('failures') ?? 0) + 1 : 0;
        await this.ctx.storage.put('failures', failures);
        await this.ctx.storage.setAlarm(Date.now() + pollDelay(failures));
      }
    });
  }
}
