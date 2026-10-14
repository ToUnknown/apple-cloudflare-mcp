import test from "node:test";
import assert from "node:assert/strict";
import { Webhook } from "standardwebhooks";
import {
  MailEventEngine,
  subscriptionId,
  filtersSchema,
  type Subscription,
  type Arrival,
  type Principal,
} from "../src/events";
import {
  callbackUrl,
  validatedAddresses,
  chatgptPost,
  publicAddress,
  signingKey,
  signedPost,
  verifyCallback,
  parseHttpResponse,
  type WebhookPost,
} from "../src/event-webhook";
import { scanInbox } from "../src/event-imap";
import type { ImapFlow } from "imapflow";
const secret = "whsec_" + Buffer.alloc(32, 7).toString("base64");
const url = "https://receiver.example/callback";
const principal: Principal = {
  userId: "owner",
  clientId: "client",
  grantId: "grant",
};
const input = {
  name: "mail.message.received",
  arguments: { mailbox: "INBOX", subjectContains: "Hello" },
  delivery: { mode: "webhook", url, secret },
};
function harness() {
  const db = new Map<string, Subscription>();
  let now = Date.now();
  let authorized = true;
  let baselineCalls = 0;
  let calls = 0;
  let status = 200;
  let reset = false;
  let messages: Arrival[] = [];
  const sent: unknown[] = [];
  const post: WebhookPost = async (_url, body, headers) => {
    const parsed = JSON.parse(body);
    assert.equal(
      headers["webhook-signature"],
      new Webhook(secret).sign(
        headers["webhook-id"],
        new Date(Number(headers["webhook-timestamp"]) * 1000),
        body,
      ),
    );
    if (parsed.type === "verification") {
      calls++;
      return {
        status: 200,
        body: JSON.stringify({ challenge: parsed.challenge }),
      };
    }
    sent.push(parsed);
    return { status, body: "" };
  };
  const deps = {
    origins: "https://receiver.example",
    post,
    now: () => now,
    load: async (id: string) => structuredClone(db.get(id)),
    save: async (id: string, s: Subscription) => {
      db.set(id, structuredClone(s));
    },
    remove: async (id: string) => {
      db.delete(id);
    },
    ids: async () => [...db.keys()],
    baseline: async () => {
      baselineCalls++;
      return { uidValidity: "1", nextUid: 10 };
    },
    scan: async () => ({
      position: { uidValidity: reset ? "2" : "1", nextUid: 20 },
      messages,
      reset,
    }),
    authorized: async () => authorized,
  };
  return {
    db,
    sent,
    deps,
    engine: () => new MailEventEngine(deps),
    advance: (ms: number) => {
      now += ms;
    },
    deny: () => {
      authorized = false;
    },
    messages: (v: Arrival[]) => {
      messages = v;
    },
    status: (s: number) => {
      status = s;
    },
    reset: () => {
      reset = true;
    },
    counts: () => ({ calls, baselineCalls }),
    now: () => now,
  };
}
const arrival = (time: number, uid = 10): Arrival => ({
  uid,
  timestamp: new Date(time).toISOString(),
  subject: "Hello",
  from: ["sender@example.com"],
  to: ["owner@example.com"],
  messageId: "<new@example.com>",
});
test("subscription identity is canonical, principal isolated, refresh does not reset baseline", async () => {
  const h = harness();
  const first = await h.engine().subscribe(principal, input);
  const second = await h
    .engine()
    .subscribe(principal, {
      ...input,
      arguments: { subjectContains: "Hello", mailbox: "INBOX" },
    });
  assert.equal(first.id, second.id);
  assert.deepEqual(h.counts(), { calls: 1, baselineCalls: 1 });
  assert.equal(h.db.size, 1);
  assert.notEqual(
    subscriptionId(
      { ...principal, clientId: "other" },
      url,
      filtersSchema.parse(input.arguments),
    ),
    first.id,
  );
  await h
    .engine()
    .unsubscribe(
      { ...principal, clientId: "other" },
      { ...input, delivery: { mode: "webhook", url } },
    );
  assert.equal(h.db.size, 1);
  await h
    .engine()
    .unsubscribe(principal, { ...input, delivery: { mode: "webhook", url } });
  assert.equal(h.db.size, 0);
});
test("filters, no historical replay, outbox restart and stable IDs on transient retry", async () => {
  const h = harness();
  const sub = await h
    .engine()
    .subscribe(principal, {
      ...input,
      arguments: { ...input.arguments, from: "SENDER@example.com" },
    });
  h.messages([
    arrival(h.now() - 10000, 9),
    arrival(h.now()),
    { ...arrival(h.now(), 11), subject: "unrelated" },
  ]);
  h.status(503);
  await h.engine().tick(sub.id);
  assert.equal(h.sent.length, 1);
  assert.equal(h.db.get(sub.id)?.pending.length, 1);
  await h.engine().tick(sub.id);
  assert.equal(h.sent.length, 1);
  h.advance(60000);
  h.status(200);
  await h.engine().tick(sub.id);
  assert.deepEqual(h.sent[0], h.sent[1]);
  assert.equal(h.db.get(sub.id)?.pending.length, 0);
});
test("expiration, revocation and UIDVALIDITY resets never deliver stale mail", async () => {
  for (const mode of ["expired", "revoked", "reset"]) {
    const h = harness();
    const sub = await h.engine().subscribe(principal, { ...input, ttlMs: 1 });
    h.messages([arrival(h.now())]);
    if (mode === "expired") h.advance(2);
    else if (mode === "revoked") h.deny();
    else h.reset();
    await h.engine().tick(sub.id);
    assert.equal(h.sent.length, 0);
    if (mode !== "reset") assert.equal(h.db.size, 0);
  }
});
test("410 ends subscription; 413 is not retried; retries bounded", async () => {
  for (const status of [410, 413, 503]) {
    const h = harness();
    const sub = await h.engine().subscribe(principal, input);
    h.messages([arrival(h.now())]);
    h.status(status);
    await h.engine().tick(sub.id);
    if (status === 410) assert.equal(h.db.size, 0);
    else if (status === 413) {
      assert.equal(h.db.get(sub.id)?.pending.length, 0);
      assert.equal(h.db.get(sub.id)?.failedDeliveries, 1);
    } else {
      for (let i = 0; i < 7; i++) {
        h.advance(3600000);
        await h.engine().tick(sub.id);
      }
      assert.equal(h.sent.length, 8);
      assert.equal(h.db.get(sub.id)?.pending.length, 0);
    }
  }
});
test("callback challenge must match and be successful; signing rotation works", async () => {
  const dest = { id: "sub", url, secret };
  for (const response of [
    { status: 200, body: '{"challenge":"wrong"}' },
    { status: 302, body: "{}" },
  ])
    await assert.rejects(
      verifyCallback(dest, "https://receiver.example", async () => response),
    );
  const newKey = "whsec_" + Buffer.alloc(32, 9).toString("base64");
  await signedPost(
    {
      ...dest,
      secret: newKey,
      previousSecret: secret,
      rotationUntil: Date.now() + 10000,
    },
    "event",
    { eventId: "event" },
    "https://receiver.example",
    async (_u, body, headers) => {
      assert.ok(new Webhook(secret).verify(body, headers));
      assert.ok(new Webhook(newKey).verify(body, headers));
      return { status: 200, body: "" };
    },
  );
});
test("reject unsafe callback URLs, reserved DNS answers and invalid secrets", () => {
  for (const u of [
    "http://receiver.example/a",
    "https://user@receiver.example/a",
    "https://receiver.example:444/a",
    "https://127.0.0.1/a",
    "https://receiver.example.evil/a",
    "https://receiver.example/a#x",
  ])
    assert.throws(() => callbackUrl(u, "https://receiver.example"));
  for (const ip of [
    "127.0.0.1",
    "10.1.2.3",
    "169.254.169.254",
    "192.168.1.1",
    "::1",
    "fc00::1",
    "::ffff:127.0.0.1",
    "100.64.0.1",
    "192.0.2.1",
  ])
    assert.equal(publicAddress(ip), false, ip);
  assert.equal(publicAddress("1.1.1.1"), true);
  for (const key of [
    "bad",
    "whsec_abc",
    "whsec_" + Buffer.alloc(65).toString("base64"),
  ])
    assert.throws(() => signingKey(key));
});
test("HTTP callback parser handles fixed and chunked bodies, rejects truncation", () => {
  assert.deepEqual(
    parseHttpResponse(
      Buffer.from("HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\n{}"),
    ),
    { status: 200, body: "{}" },
  );
  assert.equal(
    parseHttpResponse(
      Buffer.from(
        "HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n2\r\n{}\r\n0\r\n\r\n",
      ),
    ).body,
    "{}",
  );
  assert.throws(() =>
    parseHttpResponse(
      Buffer.from("HTTP/1.1 200 OK\r\nContent-Length: 10\r\n\r\n{}"),
    ),
  );
});
test("IMAP baseline does not fetch history; finite UID range and read-only selection", async () => {
  const ranges: string[] = [];
  let released = 0;
  const fake = {
    mailbox: { uidValidity: 1n, uidNext: 15 },
    getMailboxLock: async (name: string, options: unknown) => {
      assert.equal(name, "INBOX");
      assert.deepEqual(options, { readOnly: true });
      return {
        release() {
          released++;
        },
      };
    },
    async *fetch(range: string) {
      ranges.push(range);
      yield {
        uid: 10,
        internalDate: new Date(),
        envelope: { subject: "Hello" },
      };
    },
  } as unknown as ImapFlow;
  assert.equal((await scanInbox(fake)).position.nextUid, 15);
  assert.equal(ranges.length, 0);
  const scan = await scanInbox(fake, { uidValidity: "1", nextUid: 10 });
  assert.deepEqual(ranges, ["10:14"]);
  assert.equal(scan.messages.length, 1);
  assert.equal(released, 2);
  assert.equal(
    (await scanInbox(fake, { uidValidity: "2", nextUid: 10 })).reset,
    true,
  );
  assert.equal(ranges.length, 1);
});

test("stored subscriptions are encrypted and bound to their identity", async () => {
  const { seal, unseal } = await import("../src/event-crypto");
  const key = Buffer.alloc(32, 2).toString("base64");
  const state = { secret, url, principal };
  const encrypted = await seal(state, key, "sub-1");
  assert.ok(!encrypted.includes(secret));
  assert.deepEqual(await unseal(encrypted, key, "sub-1"), state);
  await assert.rejects(unseal(encrypted, key, "sub-2"));
  await assert.rejects(
    unseal(encrypted, Buffer.alloc(32, 3).toString("base64"), "sub-1"),
  );
  await assert.rejects(seal(state, undefined, "sub-1"));
});


test("idle checkpoints skip writes; progress, UID resets and rotation cleanup persist", async () => {
  const h = harness();
  const { id } = await h.engine().subscribe(principal, input);
  let writes = 0;
  const save = h.deps.save;
  h.deps.save = async (key, state) => { writes++; await save(key, state); };
  await h.engine().tick(id); // Advance the baseline from UID 10 to 20.
  assert.equal(writes, 1);
  for (let i = 0; i < 5; i++) await h.engine().tick(id);
  assert.equal(writes, 1);
  h.reset();
  await h.engine().tick(id);
  assert.equal(writes, 2);
  assert.equal(h.db.get(id)!.position.uidValidity, "2");
  const state = h.db.get(id)!;
  state.previousSecret = secret;
  state.rotationUntil = h.now() - 1;
  await h.engine().tick(id);
  assert.equal(writes, 3);
  assert.equal(h.db.get(id)!.previousSecret, undefined);
  await h.engine().tick(id);
  assert.equal(writes, 3);
});


test("Workerd DNS CNAME records do not invalidate public addresses; private IPs still fail closed", () => {
  assert.deepEqual(validatedAddresses(["callback.edge.example.", "8.8.8.8", "callback.edge.example.", "2001:4860:4860::8888"]), ["8.8.8.8", "2001:4860:4860::8888"]);
  assert.throws(() => validatedAddresses(["alias.example."]));
  assert.throws(() => validatedAddresses(["alias.example.", "8.8.8.8", "127.0.0.1"]));
  assert.throws(() => validatedAddresses(["8.8.8.8", "::ffff:10.0.0.1"]));
  assert.throws(() => validatedAddresses([]));
});


test("ChatGPT HTTPS transport restricts the exact origin, preserves bytes, blocks redirects and bounds responses", async () => {
  const dest = new URL("https://connectors.api.openai.com/example");
  let calls = 0;
  const send = (async (url: string | URL | Request, init?: RequestInit) => {
    calls++; assert.equal(url, dest.href); assert.equal(init?.redirect, "manual");
    assert.equal(init?.body, '{"challenge":"test"}');
    assert.deepEqual(init?.headers, {"webhook-signature":"test"});
    return new Response('{"challenge":"test"}', {status:200});
  }) as typeof fetch;
  assert.equal((await chatgptPost(dest, '{"challenge":"test"}', {"webhook-signature":"test"}, send)).status, 200);
  await assert.rejects(chatgptPost(new URL("https://connectors.api.openai.com.attacker.example/"), "", {}, send));
  assert.equal(calls, 1);
  await assert.rejects(chatgptPost(dest,"",{}, (async()=>new Response(null,{status:302,headers:{location:"http://127.0.0.1/"}})) as typeof fetch));
  await assert.rejects(chatgptPost(dest,"",{}, (async()=>new Response("x".repeat(16385))) as typeof fetch));
});
