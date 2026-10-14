import { describe, it, expect } from "vitest";
import {
  parseCard,
  patchCard,
  serialize,
  membership,
  splitCards,
  value,
  newCard,
  clearProperties,
} from "../src/vcard";
const original =
  'BEGIN:VCARD\r\nVERSION:3.0\r\nUID:abc\r\nFN:Alice\r\nitem1.EMAIL;TYPE=INTERNET:alice@example.invalid\r\nitem1.X-ABLabel:Work\r\nPHOTO;ENCODING=b;TYPE=JPEG:QUJD\r\nX-PHONETIC-FIRST-NAME:Alis\r\nX-UNKNOWN;X-PARAM="a;b":hello\\,world\r\nNOTE:folded\r\n continuation\r\nEND:VCARD\r\n';
describe("vCards", () => {
  it("preserves labels, photos, phonetics and unknown fields when changing FN", () => {
    const lines = parseCard(original);
    const card = serialize(
      patchCard(lines, [{ name: "FN", value: "New Name" }]),
    );
    expect(card).toContain("PHOTO;ENCODING=b;TYPE=JPEG:QUJD");
    expect(card).toContain("item1.X-ABLabel:Work");
    expect(card).toContain('X-UNKNOWN;X-PARAM="a;b":hello\\,world');
    expect(card).toContain("NOTE:foldedcontinuation");
    expect(value(parseCard(card), "FN")).toBe("New Name");
  });
  it("stores group memberships separately and deduplicates additions", () => {
    const group = newCard("Friends", true);
    const joined = membership(membership(group, "abc", true), "abc", true);
    expect(joined.filter((l) => l.includes("MEMBER"))).toEqual([
      "X-ADDRESSBOOKSERVER-MEMBER:urn:uuid:abc",
    ]);
    expect(membership(joined, "abc", false)).toEqual(group);
  });
  it("preserves UTF8 and correctly folds long values", () => {
    const c = serialize(
      patchCard(newCard("Alice"), [{ name: "NOTE", value: "😀".repeat(100) }]),
    );
    expect(value(parseCard(c), "NOTE")).toBe("😀".repeat(100));
    for (const line of c.split("\r\n"))
      expect(new TextEncoder().encode(line).length).toBeLessThanOrEqual(75);
  });
  it("rejects malformed import instead of dropping records", () => {
    expect(() => splitCards(original + "invalid")).toThrow();
    expect(splitCards(original + original)).toHaveLength(2);
    expect(() => parseCard(original.replace("UID:abc\r\n", ""))).toThrow();
  });
  it("protects UID and membership from property edits", () => {
    expect(() =>
      patchCard(parseCard(original), [{ name: "UID", value: "bad" }]),
    ).toThrow();
    expect(() => clearProperties(parseCard(original), ["UID"])).toThrow();
  });
});
