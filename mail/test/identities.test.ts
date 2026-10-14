import test from "node:test";
import assert from "node:assert/strict";
import PostalMime from "postal-mime";
import { mailIdentities, selectSender } from "../src/identities";
import { buildMessage, buildParsedDraftMessage } from "../src/mail";
import { compose } from "../src/schema";

const env = {
  ICLOUD_USERNAME: "owner@example.invalid",
  ICLOUD_APP_PASSWORD: "synthetic-only",
  MAIL_IDENTITIES:
    "owner@example.invalid,alias@example.invalid,me@custom.invalid",
  MAIL_FROM: "me@custom.invalid",
};

test("configured identities share one account and pick a preferred default", () => {
  assert.deepEqual(mailIdentities(env), {
    preferred: "me@custom.invalid",
    allowed: [
      "owner@example.invalid",
      "alias@example.invalid",
      "me@custom.invalid",
    ],
  });
  assert.equal(selectSender(env), "me@custom.invalid");
  assert.equal(
    selectSender(env, "ALIAS@EXAMPLE.INVALID"),
    "alias@example.invalid",
  );
  assert.equal(
    selectSender({ ICLOUD_USERNAME: env.ICLOUD_USERNAME }),
    env.ICLOUD_USERNAME,
  );
  assert.equal(
    selectSender({
      ICLOUD_USERNAME: env.ICLOUD_USERNAME,
      MAIL_FROM: "alias@example.invalid",
    }),
    "alias@example.invalid",
  );
  assert.throws(
    () => mailIdentities({ ...env, MAIL_FROM: "other@example.invalid" }),
    /must be listed/,
  );
  assert.throws(
    () => selectSender(env, "attacker@example.invalid"),
    /not allowed/,
  );
});

test("identity configuration and compose reject sender header injection and malformed allowlists", () => {
  for (const value of [
    "alias@example.invalid\r\nBcc: stolen@example.invalid",
    "Alice <alias@example.invalid>",
    "",
  ]) {
    assert.throws(
      () => mailIdentities({ ...env, MAIL_IDENTITIES: value }),
      /plain email addresses/,
    );
    assert.throws(() => selectSender(env, value));
  }
  assert.throws(() =>
    mailIdentities({ ...env, MAIL_IDENTITIES: "alias@example.invalid," }),
  );
  assert.throws(() =>
    mailIdentities({
      ...env,
      MAIL_FROM: "owner@example.invalid\r\nSender: attacker@example.invalid",
    }),
  );
  assert.throws(() =>
    compose.parse({
      from: "alias@example.invalid\r\nBcc: stolen@example.invalid",
    }),
  );
});

test("reply defaults use allowed receiving To then Cc, never incoming From/Reply-To", async () => {
  const parse = (headers: string) =>
    PostalMime.parse(
      `From: alias@example.invalid\r\nReply-To: me@custom.invalid\r\n${headers}\r\nMessage-ID: <original@example.invalid>\r\n\r\nMail.`,
    );
  const toAlias = await parse(
    "To: Someone <outside@example.invalid>, Alias <alias@example.invalid>\r\nCc: me@custom.invalid",
  );
  assert.equal(selectSender(env, undefined, toAlias), "alias@example.invalid");
  const ccAlias = await parse(
    "To: outside@example.invalid\r\nCc: Team: Alias <alias@example.invalid>;",
  );
  assert.equal(selectSender(env, undefined, ccAlias), "alias@example.invalid");
  const spoofedFrom = await parse(
    "To: outside@example.invalid\r\nCc: other@example.invalid",
  );
  assert.equal(selectSender(env, undefined, spoofedFrom), "me@custom.invalid");
  assert.equal(
    selectSender(env, "owner@example.invalid", toAlias),
    "owner@example.invalid",
  );
  assert.equal(
    selectSender(env, undefined, {
      to: [
        {
          name: "Injected",
          address: "alias@example.invalid\r\nBcc: attacker@example.invalid",
        },
      ],
    }),
    "me@custom.invalid",
  );
});

test("composed and saved draft MIME carries the explicit or preferred identity", async () => {
  const preferred = await buildMessage(
    env,
    compose.parse({ to: ["friend@example.invalid"], text: "New message" }),
    "<preferred@example.invalid>",
  );
  assert.equal(preferred.from, "me@custom.invalid");
  assert.equal(
    (await PostalMime.parse(preferred.raw)).from?.address,
    preferred.from,
  );
  const draft = await buildMessage(
    env,
    compose.parse({
      from: "alias@example.invalid",
      to: ["friend@example.invalid"],
      text: "Draft",
    }),
    "<draft@example.invalid>",
    { keepBcc: true },
  );
  assert.equal(draft.from, "alias@example.invalid");
  assert.equal(
    (await PostalMime.parse(draft.raw)).from?.address,
    "alias@example.invalid",
  );
  await assert.rejects(
    buildMessage(
      env,
      compose.parse({ from: "attacker@example.invalid" }),
      "<rejected@example.invalid>",
    ),
    /not allowed/,
  );
});

test("stored draft send preserves an allowed identity and supports an explicit allowed override", async () => {
  const parsed = await PostalMime.parse(
    "From: Alias <alias@example.invalid>\r\nTo: friend@example.invalid\r\nCc: owner@example.invalid\r\nIn-Reply-To: <original@example.invalid>\r\nSubject: Draft\r\n\r\nDraft content.",
  );
  const preserved = await buildParsedDraftMessage(
    env,
    parsed,
    "<sent@example.invalid>",
  );
  const sent = await PostalMime.parse(preserved.raw);
  assert.equal(preserved.from, "alias@example.invalid");
  assert.equal(sent.from?.address, "alias@example.invalid");
  assert.equal(sent.inReplyTo, "<original@example.invalid>");
  const override = await buildParsedDraftMessage(
    env,
    parsed,
    "<override@example.invalid>",
    "owner@example.invalid",
  );
  assert.equal(
    (await PostalMime.parse(override.raw)).from?.address,
    "owner@example.invalid",
  );
  const unallowed = await PostalMime.parse(
    "From: attacker@example.invalid\r\nTo: friend@example.invalid\r\n\r\nDraft.",
  );
  await assert.rejects(
    buildParsedDraftMessage(env, unallowed, "<bad@example.invalid>"),
    /not allowed/,
  );
  await assert.rejects(
    buildParsedDraftMessage(
      env,
      parsed,
      "<bad@example.invalid>",
      "attacker@example.invalid",
    ),
    /not allowed/,
  );
});
