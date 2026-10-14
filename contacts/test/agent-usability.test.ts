import { describe, expect, it } from "vitest";
import { applySimple, compactContact, simpleContact } from "../src/simple";
import {
  canonical,
  createOnce,
  publicReceipt,
  type CreationRecord,
  type CreationStore,
} from "../src/creation";
import { actionableError } from "../src/errors";
import { newCard, serialize, value } from "../src/vcard";

class MemoryStore implements CreationStore {
  record: CreationRecord | null = null;
  async reserve(record: CreationRecord) {
    if (this.record) return this.record;
    this.record = record;
    return null;
  }
  async complete(record: CreationRecord) {
    this.record = record;
  }
  async receipt() {
    return this.record;
  }
}
const operationId = "35b0adb2-2552-42d2-870b-b389036f9e29";

describe("agent-friendly contact fields", () => {
  it("escapes plain strings and preserves omitted structured components and unknown fields", () => {
    const original = newCard("Original");
    original.splice(
      original.length - 1,
      0,
      "X-CUSTOM:keep",
      "PHOTO;ENCODING=b:QUJD",
    );
    let lines = applySimple(
      original,
      simpleContact.parse({
        name: "Semi; Comma, Slash\\ New\nLine",
        givenName: "Given;Name",
        familyName: "Family,Name",
        emails: ["test@example.invalid"],
        phones: ["+49 000000"],
        note: "one\ntwo",
      }),
    );
    expect(value(lines, "FN")).toBe("Semi\\; Comma\\, Slash\\\\ New\\nLine");
    expect(value(lines, "N")).toBe("Family\\,Name;Given\\;Name;;;");
    lines = applySimple(lines, { givenName: "Changed" });
    expect(value(lines, "N")).toBe("Family\\,Name;Changed;;;");
    expect(value(lines, "EMAIL")).toBe("test@example.invalid");
    expect(serialize(lines)).toContain("X-CUSTOM:keep");
    expect(serialize(lines)).toContain("PHOTO;ENCODING=b:QUJD");
    expect(value(lines, "NOTE")).toBe("one\\ntwo");
  });
  it("empty arrays remove grouped values and orphan labels while preserving labels of surviving properties", () => {
    const lines = newCard("Grouped");
    lines.splice(
      lines.length - 1,
      0,
      "item1.EMAIL:old@example.invalid",
      "item1.X-ABLabel:Home",
      "item2.TEL:123",
      "item2.X-ABLabel:Work",
      "item2.URL:https://example.invalid",
      "X-CUSTOM:keep",
    );
    const edited = serialize(applySimple(lines, { emails: [], phones: [] }));
    expect(edited).not.toContain("EMAIL:");
    expect(edited).not.toContain("TEL:");
    expect(edited).not.toContain("item1.X-ABLabel");
    expect(edited).toContain("item2.X-ABLabel:Work");
    expect(edited).toContain("item2.URL:https://example.invalid");
  });
  it("compact results omit vCards/photos and bound repeated fields", () => {
    const lines = applySimple(newCard("Compact"), {
      emails: Array.from({ length: 6 }, (_, i) => `e${i}@example.invalid`),
      phones: ["123"],
      company: "Acme",
    });
    lines.splice(
      lines.length - 1,
      0,
      "PHOTO;ENCODING=b:QUJD",
      "NOTE:private-detail",
    );
    const result = compactContact({
      id: "https://example.invalid/card.vcf",
      etag: '"1"',
      uid: value(lines, "UID"),
      name: "Compact",
      group: false,
      vcard: serialize(lines),
    });
    expect(result.emails).toHaveLength(5);
    expect(result.detailsTruncated).toBe(true);
    expect(result).toMatchObject({
      name: "Compact",
      phones: ["123"],
      company: "Acme",
    });
    expect(JSON.stringify(result)).not.toMatch(
      /vcard|PHOTO|QUJD|private-detail/,
    );
  });
  it("rejects malformed emails and impossible dates", () => {
    expect(simpleContact.safeParse({ emails: ["invalid"] }).success).toBe(
      false,
    );
    expect(() =>
      applySimple(newCard("Date"), { birthday: "2025-02-30" }),
    ).toThrow("Invalid birthday date");
  });
});

describe("durable creation retry contract", () => {
  it("canonicalizes object key order and ignores undefined fields without reordering arrays", () => {
    expect(canonical({ b: 2, a: 1, ignored: undefined })).toBe(
      canonical({ a: 1, b: 2 }),
    );
    expect(canonical([1, 2])).not.toBe(canonical([2, 1]));
  });
  it("replays identical intent, hides fingerprint, and rejects changed intent without another write", async () => {
    const store = new MemoryStore();
    let writes = 0;
    const action = async () => {
      writes++;
      return { id: "fixture", etag: '"1"' };
    };
    expect(
      await createOnce(store, operationId, { b: 2, a: 1 }, action),
    ).toMatchObject({ replayed: false, status: "created" });
    expect(
      await createOnce(store, operationId, { a: 1, b: 2 }, action),
    ).toMatchObject({ replayed: true, id: "fixture" });
    expect(publicReceipt(await store.receipt())).not.toHaveProperty(
      "fingerprint",
    );
    await expect(
      createOnce(store, operationId, { a: 2 }, action),
    ).rejects.toMatchObject({ code: "OPERATION_CONFLICT" });
    expect(writes).toBe(1);
  });
  it("blocks concurrent pending retries and permanently blocks uncertain retries", async () => {
    const store = new MemoryStore();
    let writes = 0;
    let release!: () => void;
    const waiting = new Promise<void>((resolve) => {
      release = resolve;
    });
    const first = createOnce(store, operationId, {}, async () => {
      writes++;
      await waiting;
      return { id: "fixture" };
    });
    // Wait until the first invocation has reserved its durable receipt.
    while (!store.record)
      await new Promise((resolve) => setTimeout(resolve, 0));
    await expect(
      createOnce(store, operationId, {}, async () => {
        writes++;
        return { id: "duplicate" };
      }),
    ).rejects.toMatchObject({ code: "WRITE_UNCERTAIN" });
    release();
    await first;
    expect(writes).toBe(1);
    const uncertain = new MemoryStore();
    await expect(
      createOnce(uncertain, operationId, {}, async () => {
        throw new Error("connection lost after PUT");
      }),
    ).rejects.toMatchObject({ code: "WRITE_UNCERTAIN" });
    expect(uncertain.record?.status).toBe("uncertain");
    await expect(
      createOnce(uncertain, operationId, {}, async () => {
        throw new Error("must not run");
      }),
    ).rejects.toMatchObject({ code: "WRITE_UNCERTAIN" });
  });
  it("requires an operation key and storage before writing", async () => {
    let writes = 0;
    const action = async () => {
      writes++;
      return { id: "fixture" };
    };
    await expect(
      createOnce(new MemoryStore(), undefined, {}, action),
    ).rejects.toMatchObject({ code: "OPERATION_ID_REQUIRED" });
    await expect(
      createOnce(undefined, operationId, {}, action),
    ).rejects.toMatchObject({ code: "NOT_CONFIGURED" });
    expect(writes).toBe(0);
  });
});

it("structured errors distinguish read retries, uncertain writes, and conflicts", () => {
  expect(actionableError("Network request failed", false)).toMatchObject({
    code: "TEMPORARILY_UNAVAILABLE",
    retryable: true,
  });
  expect(actionableError("Network request failed", true)).toMatchObject({
    code: "WRITE_UNCERTAIN",
    retryable: false,
  });
  expect(actionableError("ETag differs", true)).toMatchObject({
    code: "CONFLICT",
    retryable: false,
  });
  expect(actionableError("Forbidden", false)).toMatchObject({
    code: "ACCESS_DENIED",
    retryable: false,
  });
  expect(actionableError("Invalid input", false).nextAction).toBeTruthy();
});
