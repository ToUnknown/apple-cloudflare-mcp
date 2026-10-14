import { z } from "zod";
export const MAX_MESSAGE = 2 * 1024 * 1024;
export const MAX_ATTACHMENT = 1024 * 1024;
export const safeText = z
  .string()
  .max(500)
  .regex(/^[^\r\n\0]*$/, "No line breaks or NUL");
export const mailbox = safeText.min(1);
export const ref = z.object({
  mailbox,
  uid: z.number().int().min(1).max(4294967295),
  uidValidity: z.string().regex(/^\d{1,20}$/),
});
export type MessageRef = z.infer<typeof ref>;
export const email = z
  .string()
  .email()
  .max(254)
  .refine((s) => !/[\r\n\0<>]/.test(s));
export const attachment = z.object({
  filename: safeText.min(1),
  contentType: safeText
    .regex(/^[a-zA-Z0-9.+-]+\/[a-zA-Z0-9.+-]+$/)
    .default("application/octet-stream"),
  base64: z.string().max(Math.ceil(MAX_ATTACHMENT / 3) * 4),
});
export const compose = z.object({
  from: email
    .optional()
    .describe(
      "Allowed sender from mail_identities. Defaults to preferred identity; replies may match the original To/Cc.",
    ),
  to: z.array(email).max(50).default([]),
  cc: z.array(email).max(50).default([]),
  bcc: z.array(email).max(50).default([]),
  subject: safeText.default(""),
  text: z.string().max(250000).default(""),
  html: z.string().max(250000).optional(),
  attachments: z.array(attachment).max(10).default([]),
  replyToMessage: ref.optional(),
});
export type Compose = z.infer<typeof compose>;
export const sendInput = z.object({
  operationId: z.string().uuid(),
  message: compose.optional(),
  draft: ref.optional(),
  from: email.optional(),
});
export class PublicError extends Error {}
export function strictBase64(value: string, max = MAX_MESSAGE): Buffer {
  if (
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(
      value,
    )
  )
    throw new PublicError("Invalid canonical base64.");
  const data = Buffer.from(value, "base64");
  if (data.length > max) throw new PublicError(`Data exceeds ${max} bytes.`);
  return data;
}
