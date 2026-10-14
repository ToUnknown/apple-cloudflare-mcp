import test from "node:test";
import assert from "node:assert/strict";
import { ImapFlow } from "imapflow";
import { createServer } from "../src/tools";
import { actionableError } from "../src/errors";
import { runSend, type Receipt } from "../src/receipt";

const env = {
  ICLOUD_USERNAME: "fixture@example.invalid",
  ICLOUD_APP_PASSWORD: "synthetic",
};
function callback(server: ReturnType<typeof createServer>, name: string) {
  return (server as any)._registeredTools[name].handler;
}

test("actual search callback defaults to bounded summaries and full detail remains available", async (t) => {
  t.mock.method(ImapFlow.prototype, "connect", async function () {});
  t.mock.method(ImapFlow.prototype, "close", function () {});
  t.mock.method(
    ImapFlow.prototype,
    "getMailboxLock",
    async function (this: any) {
      this.mailbox = { uidNext: 4, uidValidity: 99n };
      return { release() {} };
    },
  );
  let lastQuery: any;
  t.mock.method(ImapFlow.prototype, "search", async function (query: any) {
    lastQuery = query;
    return [2, 3];
  });
  t.mock.method(ImapFlow.prototype, "fetchAll", async function () {
    return [2, 3].map((uid) => ({
      uid,
      size: 2000,
      internalDate: new Date("2026-01-01Z"),
      flags: new Set(["\\Seen"]),
      envelope: {
        subject: "s".repeat(800),
        from: Array.from({ length: 8 }, () => ({
          name: "n".repeat(300),
          address: "fixture@example.invalid",
        })),
        to: [{ address: "private@example.invalid" }],
        date: new Date("2026-01-01Z"),
      },
    }));
  });
  const server = createServer(env as any);
  const search = callback(server, "mail_search");
  const compact = await search({ mailbox: "Drafts" }, {});
  assert.deepEqual(lastQuery, { uid: "1:3" });
  assert.equal(compact.structuredContent.messages[0].ref.uid, 3);
  assert.equal(compact.structuredContent.messages[0].subject.length, 500);
  assert.equal(compact.structuredContent.messages[0].from.length, 5);
  assert.equal(compact.structuredContent.messages[0].from[0].name.length, 200);
  assert.equal("envelope" in compact.structuredContent.messages[0], false);
  assert.deepEqual(
    JSON.parse(compact.content[0].text),
    compact.structuredContent,
  );
  const full = await search(
    { mailbox: "Drafts", detail: "full", seen: false },
    {},
  );
  assert.equal((lastQuery as Record<string, unknown>).seen, false);
  assert.equal(full.structuredContent.messages[0].envelope.subject.length, 800);
  assert.ok(JSON.stringify(compact).length < JSON.stringify(full).length);
  await server.close();
});

test("duplicate operation conflict is an MCP error with recovery guidance", async () => {
  const server = createServer({
    ...env,
    SEND_RECEIPTS: {
      idFromName: (id: string) => id,
      get: () => ({
        fetch: async () =>
          Response.json({
            error:
              "operationId was already used for different content. No mail sent.",
          }),
      }),
    },
  } as any);
  const result = await callback(server, "mail_send")(
    {
      operationId: "6ac7e81c-ab05-4c84-9ba7-dcda20788e4c",
      message: { to: ["fixture@example.invalid"], text: "fixture" },
    },
    {},
  );
  assert.equal(result.isError, true);
  assert.equal(result.structuredContent.error.code, "OPERATION_CONFLICT");
  assert.equal(result.structuredContent.error.retryable, false);
  assert.match(
    result.structuredContent.error.nextAction,
    /original operationId/,
  );
  await server.close();
});

test("receipt replay never invokes sending for accepted, pending or uncertain operations", async () => {
  for (const status of ["accepted", "pending", "uncertain"] as const) {
    const receipt: Receipt = {
      operationId: "fixture",
      messageId: "<fixture>",
      fingerprint: "same",
      startedAt: "2026-01-01",
      status,
    };
    let calls = 0;
    const result = await runSend(
      {
        reserve: async () => receipt,
        save: async () => {
          throw Error("must not save");
        },
      },
      receipt,
      async () => {
        calls++;
        return {};
      },
    );
    assert.equal(calls, 0);
    assert.equal("status" in result && result.status, status);
  }
});

test("recoverable read errors and uncertain writes carry different retry instructions", () => {
  assert.equal(
    actionableError("Message UID no longer exists. Search again.", false).code,
    "NOT_FOUND",
  );
  assert.equal(
    actionableError("Mailbox UIDVALIDITY changed.", false).code,
    "CONFLICT",
  );
  assert.equal(actionableError("Connection failed.", false).retryable, true);
  const write = actionableError("Write failed.", true);
  assert.equal(write.code, "WRITE_UNCERTAIN");
  assert.equal(write.retryable, false);
  assert.match(write.nextAction, /receipt/);
});

test("actual MCP callback classifies sanitized transport failures as retryable reads", async (t) => {
  t.mock.method(ImapFlow.prototype, "connect", async function () {
    throw new Error("synthetic transport failure with secret-provider-text");
  });
  t.mock.method(ImapFlow.prototype, "close", function () {});
  const server = createServer(env as any);
  const result = await callback(server, "mail_search")(
    { mailbox: "Drafts" },
    {},
  );
  assert.equal(result.isError, true);
  assert.equal(result.structuredContent.error.code, "TEMPORARILY_UNAVAILABLE");
  assert.equal(result.structuredContent.error.retryable, true);
  assert.doesNotMatch(JSON.stringify(result), /secret-provider-text/);
  await server.close();
});
