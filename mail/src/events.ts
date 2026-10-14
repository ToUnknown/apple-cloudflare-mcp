import { createHash } from "node:crypto";
import { z } from "zod";
import {
  EventError,
  callbackUrl,
  signingKey,
  signedPost,
  verifyCallback,
  type Destination,
  type WebhookPost,
} from "./event-webhook";
export const EVENT_NAME = "mail.message.received";
export const filtersSchema = z
  .object({
    mailbox: z.literal("INBOX").default("INBOX"),
    from: z
      .email()
      .max(254)
      .transform((v) => v.toLowerCase())
      .optional(),
    to: z
      .email()
      .max(254)
      .transform((v) => v.toLowerCase())
      .optional(),
    subjectContains: z.string().min(1).max(256).optional(),
  })
  .strict();
const base = z
  .object({
    name: z.literal(EVENT_NAME),
    arguments: filtersSchema.default({ mailbox: "INBOX" }),
    delivery: z
      .object({ mode: z.literal("webhook"), url: z.string().max(2048) })
      .strict(),
    _meta: z.record(z.string(), z.unknown()).optional(),
  })
  .strict();
export const subscribeSchema = base.extend({
  delivery: base.shape.delivery.extend({ secret: z.string().max(100) }),
  cursor: z.null().optional(),
  ttlMs: z.number().int().positive().nullable().optional(),
});
export const unsubscribeSchema = base;
export type Filters = z.infer<typeof filtersSchema>;
export const definition = {
  name: EVENT_NAME,
  description:
    "New arrivals in iCloud INBOX after subscription begins. Optional exact sender/recipient and case-insensitive subject substring filters are ANDed. Header summary only; use mail_read with ref for content. No history replay; moved/copied old mail is excluded by internal arrival date when available.",
  delivery: ["webhook"],
  inputSchema: z.toJSONSchema(filtersSchema, { io: "input" }),
  payloadSchema: {
    type: "object",
    additionalProperties: false,
    properties: {
      ref: {
        type: "object",
        additionalProperties: false,
        properties: {
          mailbox: { type: "string" },
          uid: { type: "integer" },
          uidValidity: { type: "string" },
        },
        required: ["mailbox", "uid", "uidValidity"],
      },
      subject: { type: "string" },
      from: { type: "array", items: { type: "string" } },
      to: { type: "array", items: { type: "string" } },
      messageId: { type: "string" },
    },
    required: ["ref", "subject", "from", "to", "messageId"],
  },
};
export interface Principal {
  userId: string;
  clientId: string;
  grantId: string;
}
export interface Position {
  uidValidity: string;
  nextUid: number;
}
export interface Arrival {
  uid: number;
  timestamp: string;
  subject: string;
  from: string[];
  to: string[];
  messageId: string;
}
export interface MailEvent {
  eventId: string;
  name: typeof EVENT_NAME;
  timestamp: string;
  data: {
    ref: { mailbox: string; uid: number; uidValidity: string };
    subject: string;
    from: string[];
    to: string[];
    messageId: string;
  };
  cursor: null;
}
interface Pending {
  event: MailEvent;
  attempts: number;
  due: number;
}
export interface Subscription extends Destination {
  principal: Principal;
  filters: Filters;
  expires: number;
  started: number;
  verifiedUntil: number;
  position: Position;
  pending: Pending[];
  failedDeliveries: number;
}
export interface EventDependencies {
  load(id: string): Promise<Subscription | undefined>;
  save(id: string, value: Subscription): Promise<void>;
  remove(id: string): Promise<void>;
  ids(): Promise<string[]>;
  baseline(): Promise<Position>;
  scan(
    position: Position,
  ): Promise<{ position: Position; messages: Arrival[]; reset: boolean }>;
  authorized(principal: Principal, fresh?: boolean): Promise<boolean>;
  origins: string;
  post?: WebhookPost;
  now?: () => number;
}
export function subscriptionId(
  principal: Principal,
  url: string,
  filters: Filters,
): string {
  const canonical = Object.fromEntries(
    Object.entries(filters).sort(([a], [b]) => a.localeCompare(b)),
  );
  return (
    "sub_" +
    createHash("sha256")
      .update(
        JSON.stringify([
          principal.userId,
          principal.clientId,
          url,
          EVENT_NAME,
          canonical,
        ]),
      )
      .digest("hex")
  );
}
export function matches(filters: Filters, m: Arrival): boolean {
  return (
    (!filters.from || m.from.some((a) => a.toLowerCase() === filters.from)) &&
    (!filters.to || m.to.some((a) => a.toLowerCase() === filters.to)) &&
    (!filters.subjectContains ||
      m.subject.toLowerCase().includes(filters.subjectContains.toLowerCase()))
  );
}
export function eventFor(m: Arrival, position: Position): MailEvent {
  return {
    eventId:
      "evt_" +
      createHash("sha256")
        .update(`INBOX:${position.uidValidity}:${m.uid}`)
        .digest("hex"),
    name: EVENT_NAME,
    timestamp: m.timestamp,
    data: {
      ref: { mailbox: "INBOX", uid: m.uid, uidValidity: position.uidValidity },
      subject: m.subject,
      from: m.from,
      to: m.to,
      messageId: m.messageId,
    },
    cursor: null,
  };
}
export class MailEventEngine {
  constructor(private d: EventDependencies) {}
  private now() {
    return this.d.now?.() ?? Date.now();
  }
  async subscribe(principal: Principal, input: unknown) {
    const args = subscribeSchema.parse(input);
    const url = callbackUrl(args.delivery.url, this.d.origins).href;
    const secret = signingKey(args.delivery.secret);
    const id = subscriptionId(principal, url, args.arguments);
    const now = this.now();
    if (!(await this.d.authorized(principal, true)))
      throw new EventError(-32024, "Mail authorization was revoked");
    let old = await this.d.load(id);
    if (old && old.expires <= now) {
      await this.d.remove(id);
      old = undefined;
    }
    const active = [];
    for (const key of await this.d.ids()) {
      const candidate = await this.d.load(key);
      if (candidate && candidate.expires <= now) await this.d.remove(key);
      else if (candidate) active.push(candidate);
    }
    if (!old && active.length >= 5)
      throw new EventError(-32000, "Subscription limit reached (5)");
    const changed = old?.secret !== secret;
    const dest: Destination = { id, url, secret };
    const cached = active.find(
      (s) =>
        s.url === url &&
        s.secret === secret &&
        s.principal.userId === principal.userId &&
        s.principal.clientId === principal.clientId &&
        s.verifiedUntil > now,
    );
    if (!cached) await verifyCallback(dest, this.d.origins, this.d.post);
    const state: Subscription = {
      ...dest,
      principal,
      filters: args.arguments,
      expires: now + Math.min(args.ttlMs ?? 86400000, 86400000),
      started: old?.started ?? now,
      verifiedUntil: cached?.verifiedUntil ?? now + 300000,
      position: old?.position ?? (await this.d.baseline()),
      pending: old?.pending ?? [],
      failedDeliveries: old?.failedDeliveries ?? 0,
      previousSecret: changed ? old?.secret : old?.previousSecret,
      rotationUntil: changed ? now + 300000 : old?.rotationUntil,
    };
    await this.d.save(id, state);
    return {
      id,
      refreshBefore: new Date(state.expires).toISOString(),
      cursor: null,
      truncated: false,
    };
  }
  async unsubscribe(principal: Principal, input: unknown) {
    const args = unsubscribeSchema.parse(input);
    const url = callbackUrl(args.delivery.url, this.d.origins).href;
    await this.d.remove(subscriptionId(principal, url, args.arguments));
    return {};
  }
  async tick(id: string) {
    const state = await this.d.load(id);
    if (!state) return;
    if (
      state.expires <= this.now() ||
      !(await this.d.authorized(state.principal))
    ) {
      await this.d.remove(id);
      return;
    }
    let changed = false;
    if (state.rotationUntil && state.rotationUntil <= this.now()) {
      changed = true;
      delete state.previousSecret;
      delete state.rotationUntil;
    }
    // Persist the outbox and checkpoint together before any webhook. A crash can redeliver, never invent a new ID.
    if (!state.pending.length) {
      const previous = state.position;
      const scan = await this.d.scan(previous);
      changed ||= previous.uidValidity !== scan.position.uidValidity ||
        previous.nextUid !== scan.position.nextUid;
      state.position = scan.position;
      if (!scan.reset)
        state.pending = scan.messages
          .filter(
            (m) =>
              m.uid >= previous.nextUid &&
              m.uid < scan.position.nextUid &&
              Date.parse(m.timestamp) >= state.started &&
              matches(state.filters, m),
          )
          .map((m) => ({
            event: eventFor(m, scan.position),
            attempts: 0,
            due: this.now(),
          }));
      if (state.pending.length > 10)
        throw new Error("Arrival batch exceeded bound");
      changed ||= state.pending.length > 0;
    }
    // Idle polls do not rewrite identical encrypted subscription state.
    // Rotation cleanup is persisted even while an outbox retry is waiting.
    if (changed) await this.d.save(id, state);
    for (let sent = 0; sent < 3 && state.pending.length; sent++) {
      const pending = state.pending[0];
      if (pending.due > this.now()) break;
      // Recheck before every outbound delivery; no tokens or credentials are retained in the subscription.
      if (
        state.expires <= this.now() ||
        !(await this.d.authorized(state.principal))
      ) {
        await this.d.remove(id);
        return;
      }
      let status = 0;
      try {
        status = (
          await signedPost(
            state,
            pending.event.eventId,
            pending.event,
            this.d.origins,
            this.d.post,
            this.now(),
          )
        ).status;
      } catch {
        /* sanitized, retry below */
      }
      if (status === 410) {
        await this.d.remove(id);
        return;
      }
      if (status >= 200 && status < 300) state.pending.shift();
      else if (
        status === 413 ||
        (status >= 400 && status < 500 && status !== 408 && status !== 429) ||
        ++pending.attempts >= 8
      ) {
        state.pending.shift();
        state.failedDeliveries++;
      } else
        pending.due =
          this.now() + Math.min(3600000, 60000 * 2 ** (pending.attempts - 1));
      await this.d.save(id, state);
      if (status < 200 || status >= 300) break;
    }
  }
}
