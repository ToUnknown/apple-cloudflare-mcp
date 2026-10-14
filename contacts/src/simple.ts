import { z } from "zod";
import {
  baseName,
  property,
  parseCard,
  patchCard,
  serialize,
  unescapeText,
  escapeText,
} from "./vcard";
import type { DavRecord } from "./carddav";
export const simpleContact = z.object({
  name: z.string().min(1).max(500).optional(),
  givenName: z.string().max(200).optional(),
  familyName: z.string().max(200).optional(),
  emails: z.array(z.string().email().max(254)).max(20).optional(),
  phones: z.array(z.string().min(1).max(100)).max(20).optional(),
  company: z.string().max(500).optional(),
  note: z.string().max(20000).optional(),
  birthday: z
    .string()
    .regex(/^\d{4}-\d\d-\d\d$/)
    .optional(),
});
function nameParts(value: string): string[] {
  const parts = [""];
  let escaped = false;
  for (const char of value) {
    if (char === ";" && !escaped) parts.push("");
    else parts[parts.length - 1] += char;
    escaped = char === "\\" && !escaped;
  }
  return parts;
}
export function applySimple(
  lines: string[],
  input: z.infer<typeof simpleContact>,
) {
  const replace = (base: string, values: string[]) => {
    const groups = new Set(
      lines
        .map(property)
        .filter((p) => baseName(p) === base && p.name.includes("."))
        .map((p) => p.name.split(".")[0]),
    );
    lines = lines.filter((line) => baseName(property(line)) !== base);
    lines = lines.filter((line) => {
      const p = property(line),
        group = p.name.split(".")[0];
      return !(
        baseName(p) === "X-ABLABEL" &&
        groups.has(group) &&
        !lines.some((other) => {
          const q = property(other);
          return q.name.startsWith(group + ".") && baseName(q) !== "X-ABLABEL";
        })
      );
    });
    lines = patchCard(
      lines,
      values.map((value) => ({ name: base, value })),
    );
  };
  if (input.name !== undefined) replace("FN", [escapeText(input.name)]);
  if (input.givenName !== undefined || input.familyName !== undefined) {
    // Preserve omitted structured name components, including escaped separators.
    const old = nameParts(
      property(lines.find((l) => baseName(property(l)) === "N") ?? "N:;;;;")
        .value,
    );
    if (input.familyName !== undefined) old[0] = escapeText(input.familyName);
    if (input.givenName !== undefined) old[1] = escapeText(input.givenName);
    while (old.length < 5) old.push("");
    replace("N", [old.join(";")]);
  }
  if (input.emails !== undefined)
    replace("EMAIL", input.emails.map(escapeText));
  if (input.phones !== undefined) replace("TEL", input.phones.map(escapeText));
  if (input.company !== undefined) replace("ORG", [escapeText(input.company)]);
  if (input.note !== undefined) replace("NOTE", [escapeText(input.note)]);
  if (input.birthday !== undefined) {
    const date = new Date(input.birthday + "T00:00:00Z");
    if (
      !Number.isFinite(date.getTime()) ||
      date.toISOString().slice(0, 10) !== input.birthday
    )
      throw new Error("Invalid birthday date");
    replace("BDAY", [input.birthday]);
  }
  parseCard(serialize(lines));
  return lines;
}
export function compactContact(record: DavRecord) {
  const fields = parseCard(record.vcard).map(property);
  const get = (base: string) =>
    fields
      .filter((p) => baseName(p) === base)
      .map((p) => unescapeText(p.value));
  const emails = get("EMAIL"),
    phones = get("TEL");
  return {
    id: record.id,
    etag: record.etag,
    uid: record.uid,
    name: record.name.slice(0, 500),
    group: record.group,
    emails: emails.slice(0, 5).map((v) => v.slice(0, 254)),
    phones: phones.slice(0, 5).map((v) => v.slice(0, 100)),
    company: get("ORG")[0]?.slice(0, 500) ?? null,
    detailsTruncated: emails.length > 5 || phones.length > 5,
  };
}
