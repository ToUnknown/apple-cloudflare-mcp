import { describe, it, expect } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { CardDAV } from "../src/carddav";
import { createServer } from "../src/tools";
import { parseCard, serialize, newCard, value } from "../src/vcard";
const book = "https://p123-contacts.icloud.com/123/carddavhome/card/";
class SyntheticDAV extends CardDAV {
  records = new Map<
    string,
    {
      id: string;
      etag: string;
      vcard: string;
      uid: string;
      name: string;
      group: boolean;
    }
  >();
  writes = 0;
  constructor() {
    super("synthetic", "synthetic", async () => {
      throw new Error("No network in synthetic tool test");
    });
  }
  async discover() {
    return [{ id: book, name: "Synthetic Contacts" }];
  }
  async inventory() {
    return [...this.records.values()].map((r) => ({ id: r.id, etag: r.etag }));
  }
  async read(id: string) {
    const r = this.records.get(id);
    if (!r) throw new Error("Synthetic missing contact");
    return r;
  }
  async readMany(ids: string[]) {
    return Promise.all(ids.map((id) => this.read(id)));
  }
  async save(id: string | undefined, lines: string[], etag?: string) {
    if (id && etag !== this.records.get(id)?.etag)
      throw new Error("Synthetic ETag conflict");
    id ??= book + crypto.randomUUID() + ".vcf";
    this.writes++;
    const vcard = serialize(lines);
    this.records.set(id, {
      id,
      etag: '"' + this.writes + '"',
      vcard,
      uid: value(lines, "UID"),
      name: value(lines, "FN"),
      group: value(lines, "X-ADDRESSBOOKSERVER-KIND") === "group",
    });
    return { id, etag: '"' + this.writes + '"', saved: true as const };
  }
  async delete(id: string) {
    this.records.delete(id);
    return { deleted: true as const, id };
  }
}
async function session() {
  const dav = new SyntheticDAV();
  const receipts = new Map<string, import("../src/creation").CreationRecord>();
  const server = createServer(dav, id => ({
    async reserve(r) { const old = receipts.get(id); if(old) return old; receipts.set(id,r); return null; },
    async complete(r) { receipts.set(id,r); },
    async receipt() { return receipts.get(id) ?? null; },
  }));
  const client = new Client({ name: "synthetic", version: "1" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(a);
  await client.connect(b);
  return { dav, client, server };
}
function payload(response: Awaited<ReturnType<Client["callTool"]>>) {
  const first = response.content as { type: string; text: string }[];
  return JSON.parse(first[0].text);
}
describe("Contacts tools through real MCP SDK", () => {
  it("creates, edits preserving photos, conflicts without writing, then deletes", async () => {
    const { dav, client, server } = await session();
    try {
      const created = payload(
        await client.callTool({
          name: "save_contact",
          arguments: {
            operationId: crypto.randomUUID(),
            formattedName: "Alice",
            properties: [
              {
                name: "PHOTO",
                parameters: "ENCODING=b;TYPE=JPEG",
                value: "QUJD",
              },
              { name: "X-UNKNOWN", value: "preserve" },
            ],
          },
        }),
      );
      const edited = payload(
        await client.callTool({
          name: "save_contact",
          arguments: {
            id: created.id,
            etag: created.etag,
            formattedName: "Alice Smith",
          },
        }),
      );
      expect((await dav.read(created.id)).vcard).toContain(
        "PHOTO;ENCODING=b;TYPE=JPEG:QUJD",
      );
      expect((await dav.read(created.id)).vcard).toContain(
        "X-UNKNOWN:preserve",
      );
      const writes = dav.writes;
      expect(
        (
          await client.callTool({
            name: "save_contact",
            arguments: {
              id: created.id,
              etag: created.etag,
              formattedName: "Bad",
            },
          })
        ).isError,
      ).toBe(true);
      expect(dav.writes).toBe(writes);
      expect(
        payload(
          await client.callTool({
            name: "delete_contact",
            arguments: { id: created.id, etag: edited.etag },
          }),
        ),
      ).toMatchObject({ deleted: true });
    } finally {
      await client.close();
      await server.close();
    }
  });
  it("creates groups, adds and removes member UID references, deleting group leaves contacts", async () => {
    const { dav, client, server } = await session();
    try {
      const c = payload(
        await client.callTool({
          name: "save_contact",
          arguments: { operationId: crypto.randomUUID(), formattedName: "Bob" },
        }),
      );
      const g = payload(
        await client.callTool({
          name: "save_group",
          arguments: { name: "Friends" },
        }),
      );
      const joined = payload(
        await client.callTool({
          name: "change_group_members",
          arguments: {
            groupId: g.id,
            etag: g.etag,
            contactIds: [c.id],
            action: "add",
          },
        }),
      );
      expect((await dav.read(g.id)).vcard).toContain(
        "X-ADDRESSBOOKSERVER-MEMBER:urn:uuid:" + (await dav.read(c.id)).uid,
      );
      const listed = payload(
        await client.callTool({
          name: "read_group_members",
          arguments: { groupId: g.id },
        }),
      );
      expect(listed.members[0].contact.id).toBe(c.id);
      const removed = payload(
        await client.callTool({
          name: "change_group_members",
          arguments: {
            groupId: g.id,
            etag: joined.etag,
            contactIds: [c.id],
            action: "remove",
          },
        }),
      );
      expect((await dav.read(g.id)).vcard).not.toContain(
        "X-ADDRESSBOOKSERVER-MEMBER",
      );
      await client.callTool({
        name: "delete_group",
        arguments: { id: g.id, etag: removed.etag },
      });
      expect(dav.records.has(c.id)).toBe(true);
    } finally {
      await client.close();
      await server.close();
    }
  });
  it("imports every record, reports duplicate failure, and exports unknown fields", async () => {
    const { dav, client, server } = await session();
    try {
      const lines = newCard("Imported");
      lines.splice(lines.length - 1, 0, "X-UNKNOWN:kept");
      const raw = serialize(lines);
      const imported = payload(
        await client.callTool({
          name: "import_vcards",
          arguments: { vcard: raw + raw },
        }),
      );
      expect(imported.records).toHaveLength(2);
      expect(imported.records[0].saved).toBe(true);
      expect(imported.records[1].error).toBe("IMPORT_FAILED");
      expect(dav.writes).toBe(1);
      const exported = payload(
        await client.callTool({
          name: "export_vcards",
          arguments: { ids: [imported.records[0].id] },
        }),
      );
      expect(value(parseCard(exported.vcard), "X-UNKNOWN")).toBe("kept");
    } finally {
      await client.close();
      await server.close();
    }
  });
});

it("search batches independently of result limit and exposes continuation for empty pages", async () => {
  const { dav, client, server } = await session();
  try {
    for (let i = 0; i < 260; i++)
      await dav.save(undefined, newCard(`Person ${i}`));
    let requests = 0;
    const original = dav.readMany.bind(dav);
    dav.readMany = async (ids) => {
      requests++;
      return original(ids);
    };
    const first = payload(
      await client.callTool({
        name: "search_contacts",
        arguments: { query: "not-present", limit: 1 },
      }),
    );
    expect(first.records).toEqual([]);
    expect(first.nextOffset).toBe(250);
    expect(requests).toBe(10);
    const last = payload(
      await client.callTool({
        name: "search_contacts",
        arguments: { query: "not-present", limit: 1, offset: 250 },
      }),
    );
    expect(last.nextOffset).toBeNull();
    const one = payload(
      await client.callTool({
        name: "search_contacts",
        arguments: { limit: 1 },
      }),
    );
    expect(one.records).toHaveLength(1);
    expect(one.nextOffset).toBe(1);
  } finally {
    await client.close();
    await server.close();
  }
});

it("maps non-UUID import IDs while retaining original ID and preventing repeat imports", async () => {
  const { dav, client, server } = await session();
  try {
    const vcard =
      "BEGIN:VCARD\r\nVERSION:3.0\r\nUID:external-test-123\r\nFN:Imported Fixture\r\nX-CUSTOM:preserved\r\nEND:VCARD\r\n";
    const result = payload(
      await client.callTool({ name: "import_vcards", arguments: { vcard } }),
    ).records[0];
    expect(result.saved).toBe(true);
    expect(result.originalUid).toBe("external-test-123");
    expect(result.uid).toMatch(/^[0-9a-f-]{36}$/);
    const stored = await dav.read(result.id);
    expect(stored.vcard).toContain("X-MCP-ORIGINAL-UID:external-test-123");
    expect(stored.vcard).toContain("X-CUSTOM:preserved");
    const again = payload(
      await client.callTool({ name: "import_vcards", arguments: { vcard } }),
    ).records[0];
    expect(again.error).toBe("IMPORT_FAILED");
    expect(dav.writes).toBe(1);
  } finally {
    await client.close();
    await server.close();
  }
});
