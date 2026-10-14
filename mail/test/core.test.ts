import test from "node:test";
import assert from "node:assert/strict";
import { ImapFlow } from "imapflow";
import PostalMime from "postal-mime";
import {
  buildMessage,
  createImap,
  requireTargetedExpunge,
  assertUidValidity,
  smtpTransport,
} from "../src/mail";
import { compose, MAX_ATTACHMENT, strictBase64 } from "../src/schema";
import { runSend, type Receipt } from "../src/receipt";
import { safeError } from "../src/tools";
const env = {
  ICLOUD_USERNAME: "owner@example.invalid",
  ICLOUD_APP_PASSWORD: "synthetic-password",
};
test("production endpoints and mandatory TLS cannot be chosen by tool input", () => {
  const imap = createImap(env);
  assert.equal(imap.options.host, "imap.mail.me.com");
  assert.equal(imap.options.port, 993);
  assert.equal(imap.options.secure, true);
  assert.equal(imap.options.logger, false);
  assert.equal(imap.options.tls?.rejectUnauthorized, true);
  imap.close();
  const smtp = smtpTransport(env);
  const options = smtp.options as {
    host: string;
    port: number;
    requireTLS: boolean;
    tls: { rejectUnauthorized: boolean };
  };
  assert.equal(options.host, "smtp.mail.me.com");
  assert.equal(options.port, 587);
  assert.equal(options.requireTLS, true);
  assert.equal(options.tls.rejectUnauthorized, true);
  smtp.close();
});
test("MIME includes Unicode and attachments and removes Bcc from wire headers", async () => {
  const message = compose.parse({
    to: ["friend@example.invalid"],
    bcc: ["hidden@example.invalid"],
    subject: "Привіт",
    text: "Hello",
    attachments: [
      {
        filename: "a.txt",
        contentType: "text/plain",
        base64: Buffer.from("file content").toString("base64"),
      },
    ],
  });
  const { raw, archiveRaw, recipients } = await buildMessage(
    env,
    message,
    "<synthetic@example.invalid>",
  );
  assert.deepEqual(recipients, [
    "friend@example.invalid",
    "hidden@example.invalid",
  ]);
  assert.doesNotMatch(raw.toString().split("\r\n\r\n")[0], /^Bcc:/im);
  assert.match(
    archiveRaw.toString().split("\r\n\r\n")[0],
    /^Bcc: hidden@example.invalid/im,
  );
  const parsed = await PostalMime.parse(raw);
  assert.equal(parsed.subject, "Привіт");
  assert.equal(parsed.text?.trim(), "Hello");
  assert.equal(parsed.attachments[0].filename, "a.txt");
  assert.equal(
    Buffer.from(parsed.attachments[0].content as ArrayBuffer).toString(),
    "file content",
  );
});
test("draft MIME preserves Bcc while submission strips it", async () => {
  const message = compose.parse({
    bcc: ["hidden@example.invalid"],
    text: "Draft",
  });
  const { raw } = await buildMessage(env, message, "<draft@example.invalid>", {
    keepBcc: true,
  });
  assert.match(
    raw.toString().split("\r\n\r\n")[0],
    /^Bcc: hidden@example.invalid/im,
  );
});
test("schema rejects header injection, excess recipients and invalid/oversized base64", async () => {
  assert.throws(() =>
    compose.parse({
      to: ["victim@example.invalid\r\nBcc: injected@example.invalid"],
    }),
  );
  assert.throws(() =>
    compose.parse({ subject: "Subject\nBcc: injected@example.invalid" }),
  );
  assert.throws(() => strictBase64("not!base64"));
  assert.throws(() =>
    strictBase64(
      Buffer.alloc(MAX_ATTACHMENT + 1).toString("base64"),
      MAX_ATTACHMENT,
    ),
  );
  await assert.rejects(
    buildMessage(
      env,
      compose.parse({
        attachments: [
          { filename: "one", base64: Buffer.alloc(600000).toString("base64") },
          { filename: "two", base64: Buffer.alloc(600000).toString("base64") },
        ],
      }),
      "<large@example.invalid>",
    ),
    /Combined attachments/,
  );
});
test("UIDVALIDITY checks and targeted expunge prevent stale or broad deletion", () => {
  const c = new ImapFlow({ host: "synthetic.invalid", logger: false });
  c.mailbox = {
    path: "INBOX",
    delimiter: "/",
    uidValidity: 10n,
    uidNext: 43,
    exists: 1,
    flags: new Set(),
    permanentFlags: new Set(),
    readOnly: false,
  };
  assert.doesNotThrow(() =>
    assertUidValidity(c, { mailbox: "INBOX", uid: 42, uidValidity: "10" }),
  );
  assert.throws(
    () => assertUidValidity(c, { mailbox: "INBOX", uid: 42, uidValidity: "9" }),
    /UIDVALIDITY/,
  );
  assert.throws(() => requireTargetedExpunge(c), /refusing broad/);
  c.capabilities.set("UIDPLUS", true);
  assert.doesNotThrow(() => requireTargetedExpunge(c));
  c.close();
});
test("durable receipt reserves before SMTP, suppresses duplicate/reused/unknown sends", async () => {
  let saved: Receipt | undefined;
  let count = 0;
  const store = {
    reserve: async (r: Receipt) => {
      if (saved) return saved;
      saved = r;
      return null;
    },
    save: async (r: Receipt) => {
      saved = r;
    },
  };
  const initial: Receipt = {
    fingerprint: "same",
    operationId: "id",
    messageId: "<id@example.invalid>",
    status: "pending",
    startedAt: "now",
  };
  const action = async () => {
    count++;
    assert.equal(saved?.status, "pending");
    return {
      accepted: ["friend@example.invalid"],
      rejected: [],
      sentCopy: "saved" as const,
    };
  };
  const first = await runSend(store, initial, action);
  assert.equal("status" in first && first.status, "accepted");
  await runSend(store, initial, action);
  assert.equal(count, 1);
  const changed = await runSend(
    store,
    { ...initial, fingerprint: "different" },
    action,
  );
  assert.ok("error" in changed);
  assert.equal(count, 1);
  saved = { ...initial, status: "pending" };
  const pending = await runSend(store, initial, action);
  assert.equal("status" in pending && pending.status, "pending");
  assert.equal(count, 1);
  saved = undefined;
  const unknown = await runSend(store, initial, async () => {
    count++;
    throw Object.assign(new Error("secret SMTP reply and password"), {
      code: "ETIMEDOUT",
      command: "DATA",
    });
  });
  assert.equal("status" in unknown && unknown.status, "uncertain");
  assert.ok("errorCode" in unknown && unknown.errorCode === "ETIMEDOUT");
  assert.ok("errorCommand" in unknown && unknown.errorCommand === "DATA");
  assert.doesNotMatch(JSON.stringify(unknown), /secret SMTP|password/);
  await runSend(store, initial, action);
  assert.equal(count, 2);
});
test("errors never return raw protocol replies or account secrets", () => {
  assert.doesNotMatch(
    safeError(new Error("LOGIN synthetic-password owner@example.invalid")),
    /synthetic-password|owner@example/,
  );
});
