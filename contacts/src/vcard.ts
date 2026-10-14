/** Keep original unfolded lines: edits replace only explicitly named properties. */
export interface Property {
  name: string;
  value: string;
  parameters?: string;
}
export const escapeText = (s: string) =>
  s
    .replace(/\\/g, "\\\\")
    .replace(/\r?\n/g, "\\n")
    .replace(/;/g, "\\;")
    .replace(/,/g, "\\,");
export const unescapeText = (s: string) =>
  s.replace(/\\([nN,;\\])/g, (_, c: string) => (/n/i.test(c) ? "\n" : c));
function colon(line: string): number {
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    if (line[i] === '"') quoted = !quoted;
    if (line[i] === ":" && !quoted) return i;
  }
  return -1;
}
export function property(line: string): Property {
  const i = colon(line);
  if (i < 1) throw new Error("Malformed vCard property");
  const head = line.slice(0, i);
  const semi = head.indexOf(";");
  return {
    name: (semi < 0 ? head : head.slice(0, semi)).toUpperCase(),
    parameters: semi < 0 ? undefined : head.slice(semi + 1),
    value: line.slice(i + 1),
  };
}
export const baseName = (p: Property) => p.name.split(".").at(-1)!;
export function parseCard(text: string): string[] {
  if (new TextEncoder().encode(text).length > 1024 * 1024)
    throw new Error("vCard exceeds 1 MiB limit");
  const lines = text
    .replace(/\r\n/g, "\n")
    .replace(/\n[ \t]/g, "")
    .split("\n")
    .filter(Boolean);
  if (
    lines[0]?.toUpperCase() !== "BEGIN:VCARD" ||
    lines.at(-1)?.toUpperCase() !== "END:VCARD" ||
    lines.filter((l) => l.toUpperCase() === "BEGIN:VCARD").length !== 1
  )
    throw new Error("Expected exactly one vCard");
  for (const line of lines) {
    const p = property(line);
    if (!/^(?:[A-Z0-9-]+\.)?[A-Z0-9-]+$/.test(p.name) || /[\r\n\0]/.test(line))
      throw new Error("Malformed vCard");
  }
  if (!["3.0", "4.0"].includes(value(lines, "VERSION")))
    throw new Error("Only vCard 3.0 and 4.0 are supported");
  if (
    lines.filter((l) => baseName(property(l)) === "UID").length !== 1 ||
    !value(lines, "UID")
  )
    throw new Error("vCard requires exactly one UID");
  if (!value(lines, "FN")) throw new Error("vCard requires FN");
  return lines;
}
export const values = (lines: string[], name: string) =>
  lines
    .map(property)
    .filter((p) => baseName(p) === name.toUpperCase())
    .map((p) => p.value);
export const value = (lines: string[], name: string) =>
  values(lines, name)[0] ?? "";
export const isGroup = (lines: string[]) =>
  value(lines, "X-ADDRESSBOOKSERVER-KIND").toLowerCase() === "group" ||
  value(lines, "KIND").toLowerCase() === "group";
export function serialize(lines: string[]): string {
  return (
    lines
      .map((line) => {
        let chunks: string[] = [];
        let s = "";
        let n = 0;
        for (const c of line) {
          const bytes = new TextEncoder().encode(c).length;
          if (n + bytes > 75) {
            chunks.push(s);
            s = " " + c;
            n = 1 + bytes;
          } else {
            s += c;
            n += bytes;
          }
        }
        chunks.push(s);
        return chunks.join("\r\n");
      })
      .join("\r\n") + "\r\n"
  );
}
export function patchCard(lines: string[], replacements: Property[]): string[] {
  const names = new Set(replacements.map((p) => p.name.toUpperCase()));
  for (const p of replacements)
    if (
      !/^(?:[A-Z0-9-]+\.)?[A-Z0-9-]+$/.test(p.name.toUpperCase()) ||
      [
        "UID",
        "VERSION",
        "BEGIN",
        "END",
        "KIND",
        "X-ADDRESSBOOKSERVER-KIND",
        "X-ADDRESSBOOKSERVER-MEMBER",
        "MEMBER",
      ].includes(baseName({ ...p, name: p.name.toUpperCase() })) ||
      /[\r\n\0]/.test(p.value + (p.parameters ?? "")) ||
      p.parameters?.includes(":")
    )
      throw new Error(
        "Invalid or protected property; escape text and use membership tools for groups",
      );
  const kept = lines.filter((l) => !names.has(property(l).name));
  kept.splice(
    kept.length - 1,
    0,
    ...replacements.map(
      (p) =>
        p.name.toUpperCase() +
        (p.parameters ? ";" + p.parameters : "") +
        ":" +
        p.value,
    ),
  );
  parseCard(serialize(kept));
  return kept;
}
export function clearProperties(lines: string[], names: string[]): string[] {
  if (
    names.some(
      (n) =>
        !/^(?:[A-Z0-9-]+\.)?[A-Z0-9-]+$/i.test(n) ||
        [
          "UID",
          "VERSION",
          "BEGIN",
          "END",
          "FN",
          "KIND",
          "X-ADDRESSBOOKSERVER-KIND",
          "X-ADDRESSBOOKSERVER-MEMBER",
          "MEMBER",
        ].includes(n.toUpperCase().split(".").at(-1)!),
    )
  )
    throw new Error("Invalid or protected property");
  return lines.filter(
    (l) => !names.map((n) => n.toUpperCase()).includes(property(l).name),
  );
}
export function newCard(name: string, group = false): string[] {
  return [
    "BEGIN:VCARD",
    "VERSION:3.0",
    "UID:" + crypto.randomUUID(),
    "FN:" + escapeText(name),
    "N:;" + escapeText(name) + ";;;",
    ...(group ? ["X-ADDRESSBOOKSERVER-KIND:group"] : []),
    "END:VCARD",
  ];
}
export function membership(
  lines: string[],
  uid: string,
  add: boolean,
): string[] {
  if (!isGroup(lines)) throw new Error("Record is not a group");
  const member = "urn:uuid:" + uid.replace(/^urn:uuid:/i, "");
  const names = ["X-ADDRESSBOOKSERVER-MEMBER", "MEMBER"];
  const kept = lines.filter((l) => {
    const p = property(l);
    return !(
      names.includes(baseName(p)) &&
      p.value.toLowerCase() === member.toLowerCase()
    );
  });
  if (add)
    kept.splice(kept.length - 1, 0, "X-ADDRESSBOOKSERVER-MEMBER:" + member);
  return kept;
}
export function splitCards(text: string): string[] {
  const normalized = text.replace(/\r\n/g, "\n");
  const cards =
    normalized.match(/^BEGIN:VCARD\n[\s\S]*?^END:VCARD\s*$/gim) ?? [];
  if (
    !cards.length ||
    normalized.replace(/^BEGIN:VCARD\n[\s\S]*?^END:VCARD\s*$/gim, "").trim()
  )
    throw new Error("Invalid vCard import; no records imported");
  if (cards.length > 100)
    throw new Error("Import at most 100 vCards at a time");
  cards.forEach(parseCard);
  return cards;
}
