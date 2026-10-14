import { ImapFlow } from "imapflow";
import nodemailer from "nodemailer";
import MailComposer from "nodemailer/lib/mail-composer/index.js";
import PostalMime, { type Email } from "postal-mime";
import {
  compose,
  MAX_ATTACHMENT,
  MAX_MESSAGE,
  PublicError,
  strictBase64,
  type Compose,
  type MessageRef,
} from "./schema";
import { addresses, selectSender } from "./identities";
export interface Credentials {
  ICLOUD_USERNAME: string;
  ICLOUD_APP_PASSWORD: string;
  MAIL_FROM?: string;
  MAIL_IDENTITIES?: string;
}
export function createImap(env: Credentials): ImapFlow {
  const client = new ImapFlow({
    host: "imap.mail.me.com",
    port: 993,
    secure: true,
    auth: { user: env.ICLOUD_USERNAME, pass: env.ICLOUD_APP_PASSWORD },
    logger: false,
    logRaw: false,
    disableCompression: true,
    disableAutoIdle: true,
    connectionTimeout: 15000,
    greetingTimeout: 15000,
    socketTimeout: 30000,
    maxLineLength: 128 * 1024,
    maxLiteralSize: MAX_MESSAGE + 1024,
    maxResponseSize: MAX_MESSAGE + 128 * 1024,
    tls: { rejectUnauthorized: true, minVersion: "TLSv1.2" },
  });
  // ImapFlow emits errors as well as rejecting the command promise; suppress unsanitized logs.
  client.on("error", () => {});
  return client;
}
export async function withImap<T>(
  env: Credentials,
  action: (client: ImapFlow) => Promise<T>,
): Promise<T> {
  const client = createImap(env);
  try {
    await client.connect();
    return await action(client);
  } finally {
    client.close();
  }
}
export function assertUidValidity(client: ImapFlow, target: MessageRef): void {
  if (
    !client.mailbox ||
    client.mailbox.uidValidity.toString() !== target.uidValidity
  )
    throw new PublicError(
      "Mailbox UIDVALIDITY changed. Search again before acting.",
    );
}
export async function selected<T>(
  client: ImapFlow,
  target: MessageRef,
  action: () => Promise<T>,
): Promise<T> {
  const lock = await client.getMailboxLock(target.mailbox);
  try {
    assertUidValidity(client, target);
    const exists = await client.fetchOne(
      target.uid,
      { uid: true },
      { uid: true },
    );
    if (!exists || exists.uid !== target.uid)
      throw new PublicError("Message UID no longer exists. Search again.");
    return await action();
  } finally {
    lock.release();
  }
}
export function requireTargetedExpunge(client: ImapFlow): void {
  if (
    !client.capabilities.has("UIDPLUS") &&
    !client.capabilities.has("IMAP4rev2")
  )
    throw new PublicError(
      "Server lacks targeted UID EXPUNGE; refusing broad mailbox expunge.",
    );
}
export async function source(
  client: ImapFlow,
  target: MessageRef,
): Promise<Buffer> {
  return selected(client, target, async () => {
    const meta = await client.fetchOne(
      target.uid,
      { size: true },
      { uid: true },
    );
    if (!meta || !meta.size || meta.size > MAX_MESSAGE)
      throw new PublicError(
        "Message unavailable or exceeds the 2 MiB read limit. Use your mail client for larger messages.",
      );
    const message = await client.fetchOne(
      target.uid,
      { source: { maxLength: MAX_MESSAGE + 1 } },
      { uid: true },
    );
    if (
      !message ||
      !message.source ||
      message.source.length > MAX_MESSAGE ||
      message.source.length !== meta.size
    )
      throw new PublicError(
        "Incomplete or oversized message; refusing to parse it.",
      );
    return message.source;
  });
}
export async function readMessage(client: ImapFlow, target: MessageRef) {
  const parsed = await PostalMime.parse(await source(client, target));
  return {
    ref: target,
    subject: parsed.subject,
    from: parsed.from,
    to: parsed.to,
    cc: parsed.cc,
    bcc: parsed.bcc,
    date: parsed.date,
    messageId: parsed.messageId,
    inReplyTo: parsed.inReplyTo,
    references: parsed.references,
    text: parsed.text?.slice(0, 100000),
    html: parsed.html?.slice(0, 100000),
    bodyTruncated:
      (parsed.text?.length ?? 0) > 100000 ||
      (parsed.html?.length ?? 0) > 100000,
    attachments: parsed.attachments.map((a, index) => ({
      index,
      filename: a.filename,
      contentType: a.mimeType,
      bytes: attachmentBuffer(a.content).length,
      contentId: a.contentId,
    })),
  };
}
export async function specialFolder(
  client: ImapFlow,
  role: string,
): Promise<string> {
  const match = (await client.list()).find(
    (m) => m.specialUse?.toLowerCase() === role.toLowerCase(),
  );
  if (!match)
    throw new PublicError(
      `No ${role} special-use folder advertised. List folders and specify a destination explicitly.`,
    );
  return match.path;
}
export function fromAddress(env: Credentials): string {
  return selectSender(env);
}
export async function buildMessage(
  env: Credentials,
  input: Compose,
  messageId: string,
  options: { keepBcc?: boolean; inReplyTo?: string; references?: string } = {},
): Promise<{
  raw: Buffer;
  archiveRaw: Buffer;
  recipients: string[];
  from: string;
}> {
  const message = compose.parse(input);
  const recipients = [
    ...new Set([...message.to, ...message.cc, ...message.bcc]),
  ];
  if (recipients.length > 50)
    throw new PublicError("At most 50 total recipients.");
  const attachments = message.attachments.map((a) => ({
    filename: a.filename,
    contentType: a.contentType,
    content: strictBase64(a.base64, MAX_ATTACHMENT),
  }));
  if (attachments.reduce((n, a) => n + a.content.length, 0) > MAX_ATTACHMENT)
    throw new PublicError("Combined attachments exceed 1 MiB.");
  let sender = selectSender(env, message.from);
  let inReplyTo = options.inReplyTo;
  let references = options.references;
  if (message.replyToMessage) {
    const original = await withImap(env, (c) =>
      source(c, message.replyToMessage!),
    );
    const parsed = await PostalMime.parse(original);
    sender = selectSender(env, message.from, parsed);
    if (!parsed.messageId || /[\r\n\0]/.test(parsed.messageId))
      throw new PublicError(
        "Original message has no safe Message-ID to reply to.",
      );
    inReplyTo = parsed.messageId;
    references = [
      ...(parsed.references?.match(/<[^<>\r\n]+>/g) ?? []).slice(-20),
      parsed.messageId,
    ].join(" ");
  }
  const compiled = new MailComposer({
    from: sender,
    to: message.to,
    cc: message.cc,
    bcc: message.bcc,
    subject: message.subject,
    text: message.text,
    html: message.html,
    messageId,
    inReplyTo,
    references,
    attachments,
    disableFileAccess: true,
    disableUrlAccess: true,
  }).compile();
  compiled.keepBcc = options.keepBcc ?? false;
  const raw = await new Promise<Buffer>((resolve, reject) =>
    compiled.build((error, value) => (error ? reject(error) : resolve(value))),
  );

  if (raw.length > MAX_MESSAGE)
    throw new PublicError("Encoded message exceeds 2 MiB.");
  compiled.keepBcc = true;
  const archiveRaw = options.keepBcc
    ? raw
    : await new Promise<Buffer>((resolve, reject) =>
        compiled.build((error, value) =>
          error ? reject(error) : resolve(value),
        ),
      );
  if (archiveRaw.length > MAX_MESSAGE)
    throw new PublicError("Archive message exceeds 2 MiB.");
  return { raw, archiveRaw, recipients, from: sender };
}
export function smtpTransport(env: Credentials) {
  return nodemailer.createTransport({
    host: "smtp.mail.me.com",
    port: 587,
    secure: false,
    requireTLS: true,
    auth: { user: env.ICLOUD_USERNAME, pass: env.ICLOUD_APP_PASSWORD },
    tls: {
      servername: "smtp.mail.me.com",
      rejectUnauthorized: true,
      minVersion: "TLSv1.2",
    },
    connectionTimeout: 15000,
    greetingTimeout: 15000,
    socketTimeout: 30000,
    logger: false,
    debug: false,
    disableFileAccess: true,
    disableUrlAccess: true,
    pool: false,
  });
}
export async function submitMessage(
  env: Credentials,
  raw: Buffer,
  recipients: string[],
  transport = smtpTransport(env),
  selectedFrom?: string,
) {
  try {
    const info = await transport.sendMail({
      envelope: { from: selectSender(env, selectedFrom), to: recipients },
      raw,
    });
    return {
      accepted: info.accepted as string[],
      rejected: info.rejected as string[],
    };
  } finally {
    transport.close();
  }
}

export function attachmentBuffer(
  value: string | ArrayBuffer | Uint8Array,
): Buffer {
  if (typeof value === "string") return Buffer.from(value);
  if (value instanceof ArrayBuffer) return Buffer.from(value);
  return Buffer.from(value);
}

export async function buildDraftMessage(
  env: Credentials,
  draft: MessageRef,
  messageId: string,
  explicitFrom?: string,
) {
  const raw = await withImap(env, async (c) => {
    const data = await source(c, draft);
    const flags = await c.fetchOne(draft.uid, { flags: true }, { uid: true });
    if (!flags || !flags.flags?.has("\\Draft"))
      throw new PublicError("Target is not flagged as a draft.");
    return data;
  });
  return buildParsedDraftMessage(
    env,
    await PostalMime.parse(raw),
    messageId,
    explicitFrom,
  );
}

export async function buildParsedDraftMessage(
  env: Credentials,
  parsed: Email,
  messageId: string,
  explicitFrom?: string,
) {
  const message = compose.parse({
    from: selectSender(env, explicitFrom ?? parsed.from?.address),
    to: addresses(parsed.to),
    cc: addresses(parsed.cc),
    bcc: addresses(parsed.bcc),
    subject: parsed.subject || "",
    text: parsed.text || "",
    html: parsed.html,
    attachments: parsed.attachments.map((a) => ({
      filename: a.filename || "attachment",
      contentType: a.mimeType,
      base64: attachmentBuffer(a.content).toString("base64"),
    })),
  });
  return buildMessage(env, message, messageId, {
    inReplyTo: parsed.inReplyTo?.replace(/[\r\n\0]/g, ""),
    references: parsed.references
      ?.match(/<[^<>\r\n]+>/g)
      ?.slice(-20)
      .join(" "),
  });
}
